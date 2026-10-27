import dgram from 'dgram';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';
import {FlaschenTaschenClient, FlaschenTaschenImage} from './index';

const header = (w: number, h: number, x: number, y: number, z: number) => `P6\n${w} ${h}\n#FT: ${x} ${y} ${z}\n255\n`;

describe('FlaschenTaschenImage', () => {
  it('writes the FT header and allocates the pixels', () => {
    const image = new FlaschenTaschenImage({width: 4, height: 2, layer: 3, offsetX: 1, offsetY: 2});
    const expected = header(4, 2, 1, 2, 3);
    expect(image.buffer.subarray(0, expected.length).toString()).toBe(expected);
    expect(image.pixels.length).toBe(4 * 2 * 3);
    expect(image.width).toBe(4);
    expect(image.height).toBe(2);
  });

  it('applies defaults, ignoring undefined options', () => {
    const image = new FlaschenTaschenImage({width: undefined, layer: 2});
    expect(image.buffer.toString('latin1')).toContain(header(32, 32, 0, 0, 2));
  });

  it('plots pixels', () => {
    const image = new FlaschenTaschenImage({width: 2, height: 2});
    image.plot(1, 1, {r: 1, g: 2, b: 3});
    expect([...image.pixels]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3]);
  });

  it('blits RGB data', () => {
    const image = new FlaschenTaschenImage({width: 2, height: 1});
    image.blit(Uint8Array.of(1, 2, 3, 4, 5, 6));
    expect([...image.pixels]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('blits RGBA data against black', () => {
    const image = new FlaschenTaschenImage({width: 2, height: 1});
    image.blit(Uint8Array.of(200, 100, 50, 255, 200, 100, 50, 128), 4);
    expect([...image.pixels]).toEqual([200, 100, 50, 100, 50, 25]);
  });

  it('rejects blits of the wrong size', () => {
    const image = new FlaschenTaschenImage({width: 2, height: 2});
    expect(() => image.blit(new Uint8Array(11))).toThrow(RangeError);
    expect(() => image.blit(new Uint8Array(12), 4)).toThrow(RangeError);
  });

  it('clears to black without touching the header', () => {
    const image = new FlaschenTaschenImage({width: 2, height: 1});
    image.blit(Uint8Array.of(1, 2, 3, 4, 5, 6));
    image.clear();
    expect([...image.pixels]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(image.buffer.toString('latin1')).toContain(header(2, 1, 0, 0, 15));
  });
});

describe('FlaschenTaschenClient', () => {
  let server: dgram.Socket;
  let port: number;
  const received: Buffer[] = [];

  const nextMessage = () =>
    new Promise<Buffer>(resolve => {
      if (received.length) return resolve(received.shift()!);
      server.once('message', () => resolve(received.shift()!));
    });

  beforeAll(async () => {
    server = dgram.createSocket('udp4');
    server.on('message', msg => received.push(msg));
    await new Promise<void>(resolve => server.bind(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterEach(() => {
    received.length = 0;
  });

  afterAll(() => server.close());

  it('sends the image and resolves with the byte count', async () => {
    const client = new FlaschenTaschenClient('127.0.0.1', port);
    const image = client.create({width: 2, height: 1});
    image.blit(Uint8Array.of(1, 2, 3, 4, 5, 6));

    const bytes = await client.render(image);
    const message = await nextMessage();
    expect(bytes).toBe(image.buffer.length);
    expect(message.equals(image.buffer)).toBe(true);
    await client.close();
  });

  it('overrides layer and offset for one send only', async () => {
    const client = new FlaschenTaschenClient('127.0.0.1', port);
    const image = client.create({width: 1, height: 1, layer: 15});
    image.plot(0, 0, {r: 9, g: 8, b: 7});

    await client.render(image, {layer: 4, offsetX: 10});
    const message = await nextMessage();
    expect(message.toString('latin1')).toBe(header(1, 1, 10, 0, 4) + '\x09\x08\x07');
    expect(image.buffer.toString('latin1')).toContain(header(1, 1, 0, 0, 15));
    await client.close();
  });

  it('reuses one socket across sends', async () => {
    const client = new FlaschenTaschenClient('127.0.0.1', port);
    const image = client.create({width: 1, height: 1});
    const sources: number[] = [];
    const onMessage = (_msg: Buffer, rinfo: dgram.RemoteInfo) => sources.push(rinfo.port);
    server.on('message', onMessage);

    await client.render(image);
    await client.render(image);
    await nextMessage();
    await nextMessage();
    server.off('message', onMessage);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toBe(sources[1]);
    await client.close();
  });

  it('clears a layer with a black image', async () => {
    const client = new FlaschenTaschenClient('127.0.0.1', port);
    await client.clearLayer({width: 2, height: 2, layer: 7});
    const message = await nextMessage();
    const expected = header(2, 2, 0, 0, 7);
    expect(message.subarray(0, expected.length).toString()).toBe(expected);
    expect(message.subarray(expected.length).every(b => b === 0)).toBe(true);
    await client.close();
  });

  it('rejects when the send fails', async () => {
    const client = new FlaschenTaschenClient('127.0.0.1', port);
    // Too big for a single UDP datagram.
    const image = client.create({width: 200, height: 200});
    await expect(client.render(image)).rejects.toThrow();
    // The client still works afterwards.
    await expect(client.render(client.create({width: 1, height: 1}))).resolves.toBeGreaterThan(0);
    await client.close();
  });

  it('can be closed more than once and reopens on the next send', async () => {
    const client = new FlaschenTaschenClient('127.0.0.1', port);
    await client.close();
    await client.render(client.create({width: 1, height: 1}));
    await client.close();
    await client.close();
    await expect(client.render(client.create({width: 1, height: 1}))).resolves.toBeGreaterThan(0);
    await client.close();
  });
});
