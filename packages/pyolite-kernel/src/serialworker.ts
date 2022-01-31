let _notifyBuffer: Int32Array | null = null;
let _replyBuffer: Uint8Array | null = null;
let _port: any = null;
let _readBuffer = new Uint8Array();

// eslint-disable-next-line @typescript-eslint/naming-convention
interface Navigator {
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

async function open(index: number, options = {}) {
  const ports = await navigator.serial.getPorts();
  if (index >= ports.length) {
    throw new Error(`Port ${index} unavailable`);
  }

  await ports[index].open(options);
  _port = ports[index];

  readLoop();

  reply('ack');
}

async function close() {
  if (!_port) {
    return;
  }

  await _port.close();
  _port = null;

  reply('ack');
}

async function write(data: Uint8Array) {
  if (!_port) {
    throw new Error('Serial port is not open');
  }

  const writer = _port.writable.getWriter();
  try {
    await writer.write(data);
    reply('ack');
  } finally {
    if (writer) {
      writer.releaseLock();
    }
  }
}

async function read() {
  if (!_port) {
    throw new Error('Serial port is not open');
  }

  reply('ack', _readBuffer.subarray(0, 1024 * 1024), true);
  const bytesLeft = _readBuffer.subarray(1024 * 1024);
  _readBuffer = new Uint8Array(bytesLeft.length);
  _readBuffer.set(bytesLeft);
}

async function readLoop() {
  const reader = _port.readable.getReader();
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      const tmpBuffer = new Uint8Array(_readBuffer.length + value.length);
      tmpBuffer.set(_readBuffer, 0);
      tmpBuffer.set(value, _readBuffer.length);
      _readBuffer = tmpBuffer;
      if (done) {
        _port = null;
        break;
      }
    }
  } finally {
    if (reader) {
      reader.releaseLock();
    }
  }
}

self.onmessage = async (event: MessageEvent): Promise<void> => {
  const message = event.data;
  try {
    switch (message.type) {
      case 'setup':
        [_notifyBuffer, _replyBuffer] = message.data;
        reply('ack');
        break;
      case 'sleep':
        sleep(message.data);
        break;
      case 'open': {
        const { index, options } = message.data;
        await open(index, options);
        break;
      }
      case 'close':
        await close();
        break;
      case 'write':
        await write(message.data);
        break;
      case 'read':
        await read();
        break;
      default:
        break;
    }
    // eslint-disable-next-line prettier/prettier
  } catch (e: any) {
    replyError(e.message ? e.message : e);
    throw e;
  }
};
