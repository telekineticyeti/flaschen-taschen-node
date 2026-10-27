import dgram from 'dgram';
import fs from 'fs';

const defaultImageOptions: Required<ImageOptions> = {
  width: 32,
  height: 32,
  layer: 15,
  offsetX: 0,
  offsetY: 0,
};

/** Merges options, ignoring keys that are explicitly `undefined`. */
function withDefaults<T extends object>(defaults: Required<T>, options?: T): Required<T> {
  const merged = {...defaults};
  for (const [key, value] of Object.entries(options ?? {})) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

function ftHeader(options: Required<ImageOptions>) {
  return `P6\n${options.width} ${options.height}\n#FT: ${options.offsetX} ${options.offsetY} ${options.layer}\n255\n`;
}

/**
 * Class for constructing a binary PPM image file and transmitting it to a remote host via UDP
 * in Flaschen Taschen RGB matrix protocol.
 *
 * PPM file
 * https://netpbm.sourceforge.net/doc/ppm.html
 *
 * FT Protocol
 * https://github.com/hzeller/flaschen-taschen/blob/master/doc/protocols.md
 */
export class FlaschenTaschenClient {
  private port = 1337;
  private socket?: dgram.Socket;
  // Suppress debug messages
  public silent = true;

  constructor(private host: string, port?: number) {
    if (port) this.port = port;
  }

  /**
   * Creates and returns a Flaschen Taschen Image class instance.
   * This instance contains the immage binary buffer, in addition to
   * several helper methods for image manipulation.
   */
  public create(options?: ImageOptions) {
    return new FlaschenTaschenImage(options);
  }

  /**
   * Transmits the image buffer to the target host.
   *
   * `options` overrides the image's layer and offset for this send only, so one image can be
   * drawn to several places without rebuilding it.
   *
   * Resolves with the number of bytes sent, or rejects if the send fails.
   */
  public render(ftImage: FlaschenTaschenImage, options?: RenderOptions): Promise<number> {
    const socket = this.getSocket();

    return new Promise((resolve, reject) => {
      socket.send(ftImage.packet(options), this.port, this.host, (error, bytes) => {
        if (error) return reject(error);

        if (!this.silent) {
          console.log(`UDP message sent to ${this.host}:${this.port} (${bytes} bytes)`);
        }
        resolve(bytes);
      });
    });
  }

  /**
   * Clears a layer by sending a black image to it. On layers above 0, black is transparent,
   * so whatever is underneath shows through.
   */
  public clearLayer(options?: ImageOptions): Promise<number> {
    return this.render(this.create(options));
  }

  /**
   * Closes the UDP socket. The socket doesn't keep the process alive, so this is only needed
   * to release it early. A later `render()` opens a new one.
   */
  public close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return Promise.resolve();
    return new Promise(resolve => socket.close(() => resolve()));
  }

  private getSocket() {
    if (!this.socket) {
      const socket = dgram.createSocket('udp4');
      socket.unref();
      // Drop a broken socket; the next render opens a fresh one.
      socket.on('error', error => {
        if (!this.silent) console.error(`UDP socket error: ${error.message}`);
        if (this.socket === socket) this.socket = undefined;
        socket.close();
      });
      this.socket = socket;
    }
    return this.socket;
  }
}

/**
 * FT Image Class
 * Creates a binary buffer in PPM image format with FT specific headers.
 * Use the `plot()` or `blit()` methods to draw pixels to the image, or the write method
 * to output the buffer to a file in ppm format.
 */
export class FlaschenTaschenImage {
  public readonly width: number;
  public readonly height: number;
  public buffer: Buffer;
  private header: string;
  private options: Required<ImageOptions>;

  constructor(options?: ImageOptions) {
    this.options = withDefaults(defaultImageOptions, options);
    this.width = this.options.width;
    this.height = this.options.height;
    // PPM header packet string
    this.header = ftHeader(this.options);
    this.buffer = Buffer.alloc(this.header.length + this.width * this.height * 3);
    this.buffer.write(this.header);
  }

  /**
   * The RGB pixel data, without the header. A view into `buffer`, so writes to it change the image.
   */
  public get pixels(): Buffer {
    return this.buffer.subarray(this.header.length);
  }

  /**
   * Plot a pixel value in the PPM at the specified coordinates.
   * @param x x coordinate
   * @param y y coordinate
   * @param colour RGB value { r, g, b }
   */
  public plot(x: number, y: number, colour: RGBValue) {
    // Calculate the byte offset in image binary to make adjustments
    let offset = (x + y * this.width) * 3 + this.header.length;

    this.buffer[offset] = colour.r;
    this.buffer[offset + 1] = colour.g;
    this.buffer[offset + 2] = colour.b;
  }

  /**
   * Copies a whole image into this one. `data` holds rows top to bottom, with `channels` bytes
   * per pixel, and must be exactly `width * height * channels` bytes long.
   *
   * With 4 channels (RGBA) the alpha is applied against black, which ft-server treats as
   * transparent on layers above 0.
   */
  public blit(data: Uint8Array, channels: 3 | 4 = 3) {
    const pixelCount = this.width * this.height;
    if (data.length !== pixelCount * channels) {
      throw new RangeError(
        `Expected ${pixelCount * channels} bytes for a ${this.width}x${this.height} image with ${channels} channels, got ${data.length}`,
      );
    }

    const pixels = this.pixels;
    if (channels === 3) {
      pixels.set(data);
      return;
    }
    for (let i = 0, j = 0; i < pixelCount; i++, j += 4) {
      const alpha = data[j + 3];
      pixels[i * 3] = Math.round((data[j] * alpha) / 255);
      pixels[i * 3 + 1] = Math.round((data[j + 1] * alpha) / 255);
      pixels[i * 3 + 2] = Math.round((data[j + 2] * alpha) / 255);
    }
  }

  /**
   * Write the PPM buffer to file
   * @param path Output Path/filename. Example `./image.ppm`
   */
  public write(path: string) {
    fs.writeFile(path, this.buffer, error => {
      if (error) {
        throw new Error(error as any);
      }
    });
  }

  /**
   * Wipes the current image by setting every pixel to black.
   */
  public clear() {
    this.pixels.fill(0);
  }

  /**
   * The bytes to send. With overrides, a new header is paired with the existing pixel data,
   * so the image itself isn't changed.
   */
  public packet(options?: RenderOptions): Buffer | Buffer[] {
    if (!options) return this.buffer;
    const {layer, offsetX, offsetY} = options;
    const header = ftHeader(withDefaults(this.options, {layer, offsetX, offsetY}));
    return header === this.header ? this.buffer : [Buffer.from(header), this.pixels];
  }
}

/**
 * PPM Image options
 */
export interface ImageOptions extends RenderOptions {
  // Canvas height
  height?: number;
  // Canvas width
  width?: number;
}

/**
 * Where an image is drawn. Can be overridden per send with `render()`.
 */
export interface RenderOptions {
  // Z-offset
  layer?: number;
  // X-offset
  offsetX?: number;
  // Y-offset
  offsetY?: number;
}

export interface RGBValue {
  r: number;
  g: number;
  b: number;
}
