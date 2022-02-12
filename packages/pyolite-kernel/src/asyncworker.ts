let _notifyBuffer: Int32Array | null = null;
let _replyBuffer: Uint8Array | null = null;
let _mainThreadPort: MessagePort | null = null;

// eslint-disable-next-line @typescript-eslint/naming-convention
interface Navigator {
  // Add crossOriginIsolation to the global scope. This variable indicates
  // the correct CORS headers are set to enable the use of SharedArrayBuffer.
  // Details: https://developer.mozilla.org/en-US/docs/Web/API/crossOriginIsolated
  // Remove this once we upgrade to typescript >= 4.4
  serial: any;
}

function reply(type: string, data: any = true, raw = false) {
  if (_notifyBuffer && _replyBuffer) {
    if (raw) {
      _replyBuffer.set(data);

      Atomics.store(_notifyBuffer, 1, data.length);
      Atomics.store(_notifyBuffer, 2, 1); // Raw bytes
    } else {
      const encoder = new TextEncoder();
      const encodeResult = encoder.encode(JSON.stringify(data));
      _replyBuffer.set(encodeResult);

      Atomics.store(_notifyBuffer, 1, encodeResult.length);
      Atomics.store(_notifyBuffer, 2, 0); // JSON encoded
    }

    if (type === 'error') {
      Atomics.store(_notifyBuffer, 3, 1);
    } else {
      Atomics.store(_notifyBuffer, 3, 0);
    }

    Atomics.store(_notifyBuffer, 0, 1);
    Atomics.notify(_notifyBuffer, 0, 1);
  } else {
    self.postMessage({
      type,
      data,
    });
  }
}

function replyError(e: any) {
  reply('error', e.toString());
}

function sleep(seconds: number) {
  setTimeout(() => {
    reply('ack');
  }, seconds * 1000);
}

async function numPorts() {
  const ports = await navigator.serial.getPorts();

  reply('ports', ports.length);
}

async function prompt() {
  try {
    _mainThreadPort?.postMessage({
      type: 'requestPort',
    });
  } catch (e) {
    reply('portIndex', -1);
  }
}

class SerialPort {
  async open(index: number, options = {}) {
    const ports = await navigator.serial.getPorts();
    if (index >= ports.length) {
      throw new Error(`Port ${index} unavailable`);
    }
    const port = ports[index];
    await port.open(options);

    try {
      this._reader = port.readable.getReader();
    } catch (e) {
      replyError('The port is in use');
      return;
    }

    this._port = port;

    this.readLoop();

    reply('ack');
  }

  async close() {
    if (!this._port) {
      return;
    }

    if (this._reader) {
      this._reader.cancel();
      this._reader.releaseLock();
    }
    await this._port.close();
    this._port = null;

    reply('ack');
  }

  async write(data: Uint8Array) {
    if (!this._port) {
      throw new Error('Serial port is not open');
    }

    const writer = this._port.writable.getWriter();
    try {
      await writer.write(data);
      reply('ack');
    } finally {
      if (writer) {
        writer.releaseLock();
      }
    }
  }

  async read() {
    if (!this._port) {
      throw new Error('Serial port is not open');
    }

    reply('ack', this._readBuffer.subarray(0, 1024 * 1024), true);
    const bytesLeft = this._readBuffer.subarray(1024 * 1024);
    this._readBuffer = new Uint8Array(bytesLeft.length);
    this._readBuffer.set(bytesLeft);
  }

  async readLoop() {
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await this._reader.read();
        const tmpBuffer = new Uint8Array(this._readBuffer.length + value.length);
        tmpBuffer.set(this._readBuffer, 0);
        tmpBuffer.set(value, this._readBuffer.length);
        this._readBuffer = tmpBuffer;
        if (done) {
          this._port = null;
          break;
        }
      }
    } finally {
      if (this._reader) {
        this._reader.releaseLock();
      }
    }
  }

  static createPort() {
    const idArray = new Uint32Array(4);
    self.crypto.getRandomValues(idArray);
    const id = `${idArray[0]}-${idArray[1]}-${idArray[2]}-${idArray[3]}`;
    const port = new SerialPort();
    this._ports[id] = port;
    return id;
  }

  static getPort(id: string) {
    return this._ports[id];
  }

  private _port: any = null;
  private _readBuffer = new Uint8Array();
  private _reader: any = null;
  private static _ports: { [key: string]: SerialPort } = {};
}

async function onMainThreadMsg(event: MessageEvent) {
  const message = event.data;
  switch (message.type) {
    case 'portReply': {
      reply('portIndex', message.data);
      break;
    }
    default:
      break;
  }
}

self.onmessage = async (event: MessageEvent): Promise<void> => {
  const message = event.data;
  try {
    switch (message.type) {
      case 'setup':
        [_notifyBuffer, _replyBuffer] = message.data;
        _mainThreadPort = event.ports[0];
        _mainThreadPort.onmessage = onMainThreadMsg;
        reply('ack');
        break;
      case 'sleep':
        sleep(message.data);
        break;
      case 'numPorts':
        await numPorts();
        break;
      case 'prompt':
        await prompt();
        break;
      case 'createPort': {
        const id = SerialPort.createPort();
        reply('portId', id);
        break;
      }
      case 'openPort': {
        const { id, index, options } = message.data;
        const port = SerialPort.getPort(id);
        await port.open(index, options);
        break;
      }
      case 'closePort': {
        const { id } = message.data;
        const port = SerialPort.getPort(id);
        await port.close();
        break;
      }
      case 'writePort': {
        const { id, data } = message.data;
        const port = SerialPort.getPort(id);
        await port.write(data);
        break;
      }
      case 'readPort': {
        const { id } = message.data;
        const port = SerialPort.getPort(id);
        await port.read();
        break;
      }
      default:
        replyError(`Unexpected message type ${message.type}`);
        break;
    }
    // eslint-disable-next-line prettier/prettier
  } catch (e: any) {
    replyError(e.message ? e.message : e);
    throw e;
  }
};
