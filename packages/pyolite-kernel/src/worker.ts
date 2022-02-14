/**
 * Store the kernel and interpreter instances.
 */
// eslint-disable-next-line
// @ts-ignore: breaks typedoc
let kernel: any;
// eslint-disable-next-line
// @ts-ignore: breaks typedoc
let interpreter: any;
// eslint-disable-next-line
// @ts-ignore: breaks typedoc

let pyodide: any;

// eslint-disable-next-line
// @ts-ignore: breaks typedoc
let stdout_stream: any;
// eslint-disable-next-line
// @ts-ignore: breaks typedoc
let stderr_stream: any;
// eslint-disable-next-line
// @ts-ignore: breaks typedoc
let resolveInputReply: any;

function promptForPort() {
  pyodide.runPython(`
from IPython.display import display, Javascript, HTML
display(HTML("""
<script>
async function openSerialPort() {
const result = await navigator.serial.requestPort();
return result;
}
</script>

<div style='{display: flex}'>
<button onclick='openSerialPort()' />Select Port</button>
Please select a serial port, and re-run this code cell.
</div>
"""))
`);
}

let _asyncWorker: Worker | null = null;
// Layout in bytes (trigger [0, 1], length, encoding [0, 1], isError [0, 1])
const _notifyBuffer2 = new Int32Array(new SharedArrayBuffer(4 * 4));
const _replyBuffer2 = new Uint8Array(new SharedArrayBuffer(1024 * 1024));

function setupSerialWorker(event: MessageEvent) {
  const blob = new Blob([_asyncWorkerText.text]);
  _asyncWorker = new Worker(URL.createObjectURL(blob));

  _asyncWorker.postMessage(
    {
      type: 'setup',
      data: [_notifyBuffer2, _replyBuffer2],
    },
    [event.ports[0]]
  );
}

function sendSyncMessage(type: string, data = {}) {
  if (!_asyncWorker) {
    throw new Error('Serial worker is null');
  }

  _notifyBuffer2[0] = 0;
  _asyncWorker.postMessage({
    type,
    data,
  });

  // Block while we wait for the reply
  while (Atomics.wait(_notifyBuffer2, 0, 0, 50) === 'timed-out') {
    pyodide.checkInterrupt();
  }

  // Decode result from the reply buffer
  const numBytes = _notifyBuffer2[1];
  const jsonEncoded = _notifyBuffer2[2] === 0;
  const isError = _notifyBuffer2[3] === 1;
  let result: any = undefined;
  if (jsonEncoded) {
    if (numBytes > 0) {
      const localArray = new Uint8Array(numBytes);
      localArray.set(_replyBuffer2.subarray(0, numBytes));

      const decoder = new TextDecoder();
      const jsonStr = decoder.decode(localArray);
      result = JSON.parse(jsonStr);
    }
  } else {
    // Raw
    const localArray = new Uint8Array(numBytes);
    localArray.set(_replyBuffer2.subarray(0, numBytes));

    result = localArray;
  }

  if (isError) {
    throw new Error(result);
  }

  return result;
}

class WebSerialPort {
  constructor() {
    this._id = sendSyncMessage('createPort');
  }

  open(options: { port_num?: number; always_prompt?: boolean } = {}) {
    // eslint-disable-next-line prefer-const
    let { port_num = 0, always_prompt = true, ...port_optoins } = options;

    if (this._open) {
      throw new Error('The port is already open');
    }

    const numPorts = sendSyncMessage('numPorts');
    console.log(`Numports: ${numPorts} port_num: ${port_num}}`);
    if (port_num >= numPorts || always_prompt) {
      port_num = sendSyncMessage('prompt');
      if (port_num < 0) {
        promptForPort();
        pyodide.runPython(
          'raise RuntimeError("There are no ports availble. Please select one.")'
        );
      }
    }

    sendSyncMessage('openPort', {
      id: this._id,
      index: port_num,
      options: port_optoins,
    });
    this._open = true;
  }

  close() {
    if (!this._open) {
      return;
    }

    sendSyncMessage('closePort', { id: this._id });
    this._open = false;
  }

  write(data: any) {
    sendSyncMessage('writePort', { id: this._id, data: data.toJs() });
  }

  read() {
    const data = sendSyncMessage('readPort', { id: this._id });
    return pyodide.runPython('bytes(data)', pyodide.toPy({ data }));
  }

  private _open = false;
  private _id = '';
}

function loadWebSerial(pyodide: any) {
  const module = {
    WebSerialPort,
    open(options = {}) {
      const port = new WebSerialPort();
      port.open(options);
      return port;
    },
    list() {
      return [];
    },
    sleep(seconds: number) {
      sendSyncMessage('sleep', seconds);
    },
    prompt: promptForPort,
  };

  pyodide.registerJsModule('webserial', module);
}

function blockingSleep(seconds: number) {
  const timeoutInterval = 100; // 100ms between interrupt checks
  const millis = Math.floor(seconds * 1000);
  const loops = Math.floor(millis / timeoutInterval);
  const msRemaining = millis % timeoutInterval;

  const buffer = new Int32Array(new SharedArrayBuffer(4));
  buffer[0] = 0;
  for (let i = 0; i < loops; i++) {
    Atomics.wait(buffer, 0, 0, timeoutInterval);
    pyodide.checkInterrupt();
  }

  Atomics.wait(buffer, 0, 0, msRemaining);
}

function setupMocks() {
  const module = {
    blockingSleep,
  };

  pyodide.registerJsModule('sync_helpers', module);
}

async function setupWorkerFs() {
  await new Promise<void>((resolve, reject) => {
    BrowserFS.configure(
      {
        fs: 'AsyncMirror',
        options: {
          sync: { fs: 'InMemory' },
          async: { fs: 'WorkerFS', options: { worker: self } },
        },
      },
      (e: any) => {
        if (e) {
          reject(e);
          return;
        }
        resolve();
      }
    );
  });

  console.log('What?', [Module.FS, Module.PATH, Module.ERRNO_CODES]);
  const BFS = new BrowserFS.EmscriptenFS(Module.FS, Module.PATH, Module.ERRNO_CODES);
  Module.FS.mkdir('/data123');
  Module.FS.mount(BFS, { root: '/' }, '/data123');
}

async function installExtras() {
  await pyodide.runPythonAsync(`
    await piplite.install([
       'micro-marionette',
    ], keep_going=True)
  `);
}

/**
 * Load pyodide and initialize the interpreter.
 *
 * The first package loaded, `piplite`, is a build-time configurable wrapper
 * around `micropip` that supports multiple warehouse API endpoints, as well
 * as a multipackage summary JSON format in `all.json`.
 */
async function loadPyodideAndPackages() {
  // as of 0.17.0 indexURL must be provided
  pyodide = await loadPyodide({ indexURL });

  setupMocks();

  // this is the only use of `loadPackage`, allow `piplite` to handle the rest
  await pyodide.loadPackage(['micropip']);

  // get piplite early enough to impact pyolite dependencies
  await pyodide.runPythonAsync(`
    import micropip
    await micropip.install('${_pipliteWheelUrl}', keep_going=True)
    import piplite.piplite
    piplite.piplite._PIPLITE_DISABLE_PYPI = ${_disablePyPIFallback ? 'True' : 'False'}
    piplite.piplite._PIPLITE_URLS = ${JSON.stringify(_pipliteUrls)}
  `);

  // from this point forward, only use piplite
  await pyodide.runPythonAsync(`
    await piplite.install([
      'matplotlib',
      'ipykernel',
    ], keep_going=True)
    await piplite.install([
      'pyolite',
    ], keep_going=True);
    await piplite.install([
      'ipython',
    ], keep_going=True);
    import pyolite
  `);

  loadWebSerial(pyodide);
  await setupWorkerFs();
  await installExtras();

  // make copies of these so they don't get garbage collected
  kernel = pyodide.globals.get('pyolite').kernel_instance.copy();
  stdout_stream = pyodide.globals.get('pyolite').stdout_stream.copy();
  stderr_stream = pyodide.globals.get('pyolite').stderr_stream.copy();
  interpreter = kernel.interpreter.copy();
  interpreter.send_comm = sendComm;
}

/**
 * Recursively convert a Map to a JavaScript object
 * @param The Map object to convert
 */
function mapToObject(obj: any) {
  const out: any = obj instanceof Array ? [] : {};
  obj.forEach((value: any, key: string) => {
    out[key] =
      value instanceof Map || value instanceof Array ? mapToObject(value) : value;
  });
  return out;
}

/**
 * Format the response from the Pyodide evaluation.
 *
 * @param res The result object from the Pyodide evaluation
 */
function formatResult(res: any): any {
  if (!pyodide.isPyProxy(res)) {
    return res;
  }
  // TODO: this is a bit brittle
  const m = res.toJs();
  const results = mapToObject(m);
  return results;
}

// eslint-disable-next-line
// @ts-ignore: breaks typedoc
const pyodideReadyPromise = loadPyodideAndPackages().then(() => {
  // Let the client know the kernel has finished starting
  // This is done after pyodideReadyPromise resolves to avoid race conditions
  //
  // TODO: This might be a great opportunity to report kernel startup errors to the user
  postMessage({
    type: 'kernel_started',
  });
});

/**
 * Send a comm message to the front-end.
 *
 * @param type The type of the comm message.
 * @param content The content.
 * @param metadata The metadata.
 * @param ident The ident.
 * @param buffers The binary buffers.
 */
async function sendComm(
  type: string,
  content: any,
  metadata: any,
  ident: any,
  buffers: any
) {
  postMessage({
    type: type,
    content: formatResult(content),
    metadata: formatResult(metadata),
    ident: formatResult(ident),
    buffers: formatResult(buffers),
    parentHeader: formatResult(kernel._parent_header)['header'],
  });
}

async function getpass(prompt: string) {
  prompt = typeof prompt === 'undefined' ? '' : prompt;
  await sendInputRequest(prompt, true);
  const replyPromise = new Promise((resolve) => {
    resolveInputReply = resolve;
  });
  const result: any = await replyPromise;
  return result['value'];
}

async function input(prompt: string) {
  prompt = typeof prompt === 'undefined' ? '' : prompt;
  await sendInputRequest(prompt, false);
  const replyPromise = new Promise((resolve) => {
    resolveInputReply = resolve;
  });
  const result: any = await replyPromise;
  return result['value'];
}

/**
 * Send a input request to the front-end.
 *
 * @param prompt the text to show at the prompt
 * @param password Is the request for a password?
 */
async function sendInputRequest(prompt: string, password: boolean) {
  const content = {
    prompt,
    password,
  };
  postMessage({
    type: 'input_request',
    parentHeader: formatResult(kernel._parent_header)['header'],
    content,
  });
}

/**
 * Execute code with the interpreter.
 *
 * @param content The incoming message with the code to execute.
 */
async function execute(content: any) {
  const publishExecutionResult = (
    prompt_count: any,
    data: any,
    metadata: any
  ): void => {
    const bundle = {
      execution_count: prompt_count,
      data: formatResult(data),
      metadata: formatResult(metadata),
    };
    postMessage({
      parentHeader: formatResult(kernel._parent_header)['header'],
      bundle,
      type: 'execute_result',
    });
  };

  const publishExecutionError = (ename: any, evalue: any, traceback: any): void => {
    const bundle = {
      ename: ename,
      evalue: evalue,
      traceback: traceback,
    };
    postMessage({
      parentHeader: formatResult(kernel._parent_header)['header'],
      bundle,
      type: 'execute_error',
    });
  };

  const clearOutputCallback = (wait: boolean): void => {
    const bundle = {
      wait: formatResult(wait),
    };
    postMessage({
      parentHeader: formatResult(kernel._parent_header)['header'],
      bundle,
      type: 'clear_output',
    });
  };

  const displayDataCallback = (data: any, metadata: any, transient: any): void => {
    const bundle = {
      data: formatResult(data),
      metadata: formatResult(metadata),
      transient: formatResult(transient),
    };
    postMessage({
      parentHeader: formatResult(kernel._parent_header)['header'],
      bundle,
      type: 'display_data',
    });
  };

  const updateDisplayDataCallback = (
    data: any,
    metadata: any,
    transient: any
  ): void => {
    const bundle = {
      data: formatResult(data),
      metadata: formatResult(metadata),
      transient: formatResult(transient),
    };
    postMessage({
      parentHeader: formatResult(kernel._parent_header)['header'],
      bundle,
      type: 'update_display_data',
    });
  };

  const publishStreamCallback = (name: any, text: any): void => {
    const bundle = {
      name: formatResult(name),
      text: formatResult(text),
    };
    postMessage({
      parentHeader: formatResult(kernel._parent_header)['header'],
      bundle,
      type: 'stream',
    });
  };

  stdout_stream.publish_stream_callback = publishStreamCallback;
  stderr_stream.publish_stream_callback = publishStreamCallback;
  interpreter.display_pub.clear_output_callback = clearOutputCallback;
  interpreter.display_pub.display_data_callback = displayDataCallback;
  interpreter.display_pub.update_display_data_callback = updateDisplayDataCallback;
  interpreter.displayhook.publish_execution_result = publishExecutionResult;
  interpreter.input = input;
  interpreter.getpass = getpass;

  // Check to see if the user clicked the interrupt button while the kernel
  // wasn't executing code. If it's not caught here, it will cause the cell
  // to fail to execute.
  try {
    pyodide.checkInterrupt();
  } catch {
    // Ignore
  }

  const res = await kernel.run(content.code);
  const results = formatResult(res);

  if (results['status'] === 'error') {
    publishExecutionError(results['ename'], results['evalue'], results['traceback']);
  }

  return results;
}
/**
 * Complete the code submitted by a user.
 *
 * @param content The incoming message with the code to complete.
 */
function complete(content: any) {
  const res = kernel.complete(content.code, content.cursor_pos);
  const results = formatResult(res);
  return results;
}

/**
 * Inspect the code submitted by a user.
 *
 * @param content The incoming message with the code to inspect.
 */
function inspect(content: { code: string; cursor_pos: number; detail_level: 0 | 1 }) {
  const res = kernel.inspect(content.code, content.cursor_pos, content.detail_level);
  const results = formatResult(res);
  return results;
}

/**
 * Check code for completeness submitted by a user.
 *
 * @param content The incoming message with the code to check.
 */
function isComplete(content: { code: string }) {
  const res = kernel.is_complete(content.code);
  const results = formatResult(res);
  return results;
}

/**
 * Respond to the commInfoRequest.
 *
 * @param content The incoming message with the comm target name.
 */
function commInfo(content: any) {
  const res = kernel.comm_info(content.target_name);
  const results = formatResult(res);

  return {
    comms: results,
    status: 'ok',
  };
}

/**
 * Respond to the commOpen.
 *
 * @param content The incoming message with the comm open.
 */
function commOpen(content: any) {
  const res = kernel.comm_manager.comm_open(pyodide.toPy(content));
  const results = formatResult(res);

  return results;
}

/**
 * Respond to the commMsg.
 *
 * @param content The incoming message with the comm msg.
 */
function commMsg(content: any) {
  const res = kernel.comm_manager.comm_msg(pyodide.toPy(content));
  const results = formatResult(res);

  return results;
}

/**
 * Respond to the commClose.
 *
 * @param content The incoming message with the comm close.
 */
function commClose(content: any) {
  const res = kernel.comm_manager.comm_close(pyodide.toPy(content));
  const results = formatResult(res);

  return results;
}

function setInterruptBuffer(content: any) {
  const res = pyodide.setInterruptBuffer(content);
  const results = formatResult(res);

  return results;
}

/**
 * Process a message sent to the worker.
 *
 * @param event The message event to process
 */
self.onmessage = async (event: MessageEvent): Promise<void> => {
  await pyodideReadyPromise;
  const data = event.data;

  let results;
  const messageType = data.type;
  const messageContent = data.data;
  kernel._parent_header = pyodide.toPy(data.parent);

  switch (messageType) {
    case 'execute-request':
      results = await execute(messageContent);
      break;

    case 'input-reply':
      resolveInputReply(messageContent);
      return;

    case 'inspect-request':
      results = inspect(messageContent);
      break;

    case 'is-complete-request':
      results = isComplete(messageContent);
      break;

    case 'complete-request':
      results = complete(messageContent);
      break;

    case 'comm-info-request':
      results = commInfo(messageContent);
      break;

    case 'comm-open':
      results = commOpen(messageContent);
      break;

    case 'comm-msg':
      results = commMsg(messageContent);
      break;

    case 'comm-close':
      results = commClose(messageContent);
      break;

    case 'set-interrupt-buffer':
      results = setInterruptBuffer(messageContent);
      return; // Do not reply. A reply would end any in-process cell execution

    case 'start-async-thread':
      results = setupSerialWorker(event);
      break;

    default:
      break;
  }

  const reply = {
    parentHeader: data.parent['header'],
    type: 'reply',
    results,
  };

  postMessage(reply);
};
