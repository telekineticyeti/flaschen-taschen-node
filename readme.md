# Flaschen-Taschen Node

This library includes a number of helper functions that assist in the construction and broadcast of image files in [PPM format](https://netpbm.sourceforge.net/doc/ppm.html) to [Flaschen-Taschen](https://github.com/hzeller/flaschen-taschen) servers.

This library is a **work in progress**. It creates images in a `Buffer` and sends them to an [FT server](https://github.com/hzeller/flaschen-taschen/blob/master/doc/protocols.md) over a single reused UDP socket.

This library is written in Typescript and is loosely based on [flashenode](https://github.com/mpmckenna8/flashenode).

# Usage

```bash
# Install the npm package from this github repo
npm i github:telekineticyeti/flaschen-taschen-node#v0.1.0
```

Import the library then initiate the class with a string parameter containing the target FT server IP or hostname.

```ts
import {FlaschenTaschenClient} from 'flaschen-taschen-node';

const FTC = new FlaschenTaschenClient(
  'SERVER_IP_OR_HOSTNAME', // Your FT server address
  SERVER_PORT, // Number parameter (optional). Fefault is 1337
);

// Create an image

// The `create()` method accepts an optional parameter object.
// This object contains the following options listed below, alongside their default values.
const imageOptions = {
  // PPM Image Dimensions
  width: 32,
  height: 32,
  // On which layer to display the image. FT servers allow the display of
  // several images at once on different layers.
  layer: 15,
  // Horizontal and vertical image offset.
  offsetX: 0,
  offsetY: 0,
};

const image = FTC.create(imageOptions);
```

# API

## `FlaschenTaschenClient`

| Member                                         | Description                                                                                                                                                                                         |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new FlaschenTaschenClient(host, port = 1337)` | Client for one FT server.                                                                                                                                                                           |
| `create(options?)`                             | Returns a new `FlaschenTaschenImage` (see the options above).                                                                                                                                       |
| `render(image, options?)`                      | Sends the image. Returns a `Promise` that resolves with the bytes sent and rejects if the send fails. `options` (`layer`, `offsetX`, `offsetY`) override the image's own values for this send only. |
| `clearLayer(options?)`                         | Sends a black image. On layers above 0 black is transparent, so this clears the layer.                                                                                                              |
| `close()`                                      | Closes the UDP socket. Optional: the socket doesn't keep the process alive, and the next `render()` opens a new one.                                                                                |
| `silent`                                       | Set to `false` to log each send.                                                                                                                                                                    |

All sends share one UDP socket, opened on the first `render()`.

## `FlaschenTaschenImage`

| Member                     | Description                                                                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `width`, `height`          | Image size in pixels.                                                                                                                                                                                    |
| `buffer`                   | The whole PPM packet: FT header plus pixels.                                                                                                                                                             |
| `pixels`                   | The RGB pixel data only, as a view into `buffer`.                                                                                                                                                        |
| `plot(x, y, {r, g, b})`    | Sets one pixel.                                                                                                                                                                                          |
| `blit(data, channels = 3)` | Copies a whole image at once. `data` is `width * height * channels` bytes, rows top to bottom. With `channels = 4` (RGBA), alpha is applied against black. Throws a `RangeError` if the length is wrong. |
| `clear()`                  | Sets every pixel to black.                                                                                                                                                                               |
| `write(path)`              | Writes the PPM to a file.                                                                                                                                                                                |

# Working Example

The example below fetches an online image, uses the [Jimp library](https://www.npmjs.com/package/jimp) to manipulate the image, then plots each pixel's RGB value to the PPM image buffer. The resulting PPM image is then rendered to a remote 64x64 RGB matrix.

```ts
import fetch from 'node-fetch';
import {FlaschenTaschenClient} from './flaschen-taschen.client.class';
import Jimp from 'jimp';

(async () => {
  const FTC = new FlaschenTaschenClient('192.168.0.1');

  const url =
    'https://upload.wikimedia.org/wikipedia/commons/thumb/7/73/Front_of_the_Ostrich_Egg_Globe.jpg/1280px-Front_of_the_Ostrich_Egg_Globe.jpg';

  try {
    // node-fetch grabs the image and converts the response to a binary buffer.
    const response = await fetch(url);
    const binaryBuffer = await response.buffer();

    // Create the FT image instance that we will plot our pixels to, and render from.
    const myImage = FTC.create({height: 64, width: 64});

    // Jimp library reads the buffer, scales the image to the target size of 64 pixels, and then reads
    // the output pixel by pixel, plotting to the FT image with the class instance `plot()` method.
    Jimp.read(binaryBuffer).then(async img => {
      img.scaleToFit(64, Jimp.AUTO, Jimp.RESIZE_BEZIER);

      let w = img.getWidth(),
        h = img.getHeight();
      let pixelCount = 0;

      // Loop through the image x/y coords
      for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
          // Retrieve the RGBA value of the pixel at the current coordinate
          let pixel = Jimp.intToRGBA(img.getPixelColor(x, y));

          // Plot the colour value to our FT image class.
          myImage.plot(x, y, {r: pixel.r, g: pixel.g, b: pixel.b});

          // For debug readout.
          pixelCount++;
        }
      }

      console.log(`Sending image ${img.getWidth()}x${img.getHeight()} (${pixelCount} pixels)`);

      // Optional debug step - output the image to file
      myImage.write('./myImage.ppm');

      // Instructs FTC client class to send the image to FT server.
      await FTC.render(myImage);
    });
  } catch (error) {
    throw new Error(error as any);
  }
})();
```
