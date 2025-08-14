"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_dgram = __toESM(require("dgram"));
class Cmicoe extends utils.Adapter {
  constructor(options = {}) {
    super({
      ...options,
      name: "cmicoe"
    });
    this.sock = import_dgram.default.createSocket("udp4");
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.outputs = [];
    this.inputs = [];
  }
  sock;
  socketConnected = false;
  outputs;
  inputs;
  lastSent = 0;
  sendInterval = void 0;
  cmiIP = "";
  async onReady() {
    this.setState("info.connection", false, true);
    if (this.config.nodes != "" && (this.config.outputs == void 0 || this.config.outputs.length == 0)) {
      this.log.info("Converting old nodes string to new object...");
      this.convertNodeString();
    }
    this.setupIOs();
    await this.updateStates();
    this.cmiIP = this.config.cmiIP;
    if (this.cmiIP == "") {
      this.log.error("IP of cmi not specified! Cannot send!");
    }
    if (this.config.bind == "") {
      this.log.error("No bind ip specified. Cannot listen!");
    } else {
      this.initSocket();
    }
    let interval = this.config.sendInterval * 1e3;
    if (interval <= 0 || interval > 4294967295) {
      this.log.warn(`interval must be in range 1 <= interval <= ${4294967295} (got ${interval}). Using default 60000 ms`);
      interval = 6e4;
    }
    this.sendInterval = this.setInterval(() => {
      try {
        this.sendOutputs();
      } catch (e) {
        this.log.error("error sending outputs: " + e);
      }
    }, interval);
    await this.sendOutputs();
  }
  setupIOs() {
    if (this.config.outputs == void 0) this.config.outputs = [];
    if (this.config.inputs == void 0) this.config.inputs = [];
    this.config.outputs.forEach((o) => {
      o.nodePath = `out.node${o.node}.${o.analog ? "a" : "d"}${o.output}_${o.name}`;
      if (o.factor != void 0) o.factor = o.factor.replaceAll(",", ".");
      const fl = Number(o.factor);
      if (isNaN(fl) || fl == 0) o.fac = 1;
      else o.fac = fl;
      o.name = o.name.replaceAll(this.FORBIDDEN_CHARS, "_");
      this.outputs.push(o);
    });
    this.config.inputs.forEach((i) => {
      i.nodePath = `in.node${i.node}.${i.analog ? "a" : "d"}${i.output}_${i.name}`;
      if (i.factor != void 0) i.factor = i.factor.replaceAll(",", ".");
      const fl = Number(i.factor);
      if (isNaN(fl) || fl == 0) i.fac = 1;
      else i.fac = fl;
      i.name = i.name.replaceAll(this.FORBIDDEN_CHARS, "_");
      this.inputs.push(i);
    });
  }
  convertNodeString() {
    this.config.outputs = [];
    try {
      const outputs = this.config.nodes.split(",");
      for (let idx = 0; idx < outputs.length; idx++) {
        const output = outputs[idx];
        if (output == "") continue;
        const regex = /^(\d+)\/(\w)(\d+)$/;
        const matches = output.match(regex);
        if (matches == null) {
          this.log.warn(`output configuration "${output}" has wrong format (no match)!`);
          continue;
        }
        let digital = false;
        if (matches[2].toLowerCase() == "d") digital = true;
        else if (matches[2].toLowerCase() == "a") digital = false;
        else {
          this.log.warn(`configurated node ${output} has wrong format!`);
          continue;
        }
        const out = {
          node: parseInt(matches[1]),
          output: parseInt(matches[3]),
          analog: !digital,
          desc: "",
          name: "",
          unit: 0,
          factor: "1"
        };
        this.config.outputs.push(out);
      }
      this.log.info("Converting successful");
    } catch (e) {
      this.log.error("Nodes setting has the wrong format! Converting failed.");
    }
    this.config.nodes = "";
    this.updateConfig(this.config);
  }
  async updateStates() {
    await this.delUnusedNodes();
    await this.createStates(this.outputs, "out");
    await this.createStates(this.inputs, "in");
  }
  initSocket() {
    this.sock.on("message", (msg, rinfo) => {
      this.coeReceived(msg, rinfo);
    });
    this.sock.on("close", () => {
      this.log.debug("socket closed");
    });
    this.sock.on("listening", () => {
      const addr = this.sock.address();
      this.log.debug(`socket listening on ${addr.address}:${addr.port}`);
      this.setState("info.connection", true, true);
      this.socketConnected = true;
    });
    this.sock.on("error", (err) => {
      this.log.error(`socket error: ${err}`);
      if (err.message.includes("EADDRINUSE")) {
        this.log.error(
          "this could be caused by another instance of this adapter running. Make sure to only start one instance of this adapter."
        );
      }
    });
    this.sock.bind(this.config.port, this.config.bind);
  }
  async delUnusedNodes() {
    const states = await this.getStatesAsync("out.*");
    for (const s in states) {
      const output = this.outputFromId(s);
      if (output == null) {
        this.log.warn(`state ${s} is no longer used. Deleting...`);
        await this.delObjectAsync(s);
        continue;
      }
    }
    const inputStates = await this.getStatesAsync("in.*");
    for (const s in inputStates) {
      const input = this.inputFromId(s);
      if (input == null) {
        this.log.warn(`state ${s} is no longer used. Deleting...`);
        await this.delObjectAsync(s);
        continue;
      }
    }
  }
  async createStates(ios, type) {
    for (let idx = 0; idx < ios.length; idx++) {
      const output = ios[idx];
      const id = `${type}.node${output.node}.${output.analog ? "a" : "d"}${output.output}_${output.name}`;
      const nodeChannel = `${type}.node${output.node}`;
      const nodeObj = {
        type: "channel",
        common: {
          name: `Node ${output.node}`
        },
        native: {},
        _id: nodeChannel
      };
      await this.setObjectNotExistsAsync(nodeChannel, nodeObj);
      const obj = {
        type: "state",
        common: {
          type: output.analog ? "number" : "boolean",
          read: true,
          write: true,
          role: "value",
          name: output.desc,
          def: output.analog ? 0 : false,
          unit: this.dataTypes[output.unit]
        },
        native: {},
        _id: id
      };
      this.log.debug(`creating state with id ${id}...`);
      await this.setObjectNotExistsAsync(id, obj);
    }
    if (this.config.sendOnChange && type == "out") {
      this.log.debug(`subscribing to states`);
      this.subscribeStates("out.node*");
    }
  }
  timeout = false;
  async sendOutputs() {
    if (this.cmiIP == "") return;
    if (this.lastSent > Date.now() + 18e5) {
      if (!this.timeout) {
        this.setStateChanged("timeout", true, true);
        this.setStateChanged("info.connection", false, true);
        this.timeout = true;
      }
    } else {
      if (this.timeout) {
        this.setStateChanged("timeout", false, true);
        if (this.socketConnected) {
          this.setStateChanged("info.connection", true, true);
        }
        this.timeout = false;
      }
    }
    let outputsLeft = this.outputs.slice();
    while (outputsLeft.length > 0) {
      const output = outputsLeft[0];
      const allOutputs = outputsLeft.filter((o) => o.node == output.node && o.analog == output.analog);
      const outputsToSend = allOutputs.slice(0, Math.min(4, allOutputs.length));
      outputsLeft = outputsLeft.filter((out) => {
        return !outputsToSend.some((o) => o.analog == out.analog && o.node == out.node && o.output == out.output);
      });
      const values = await Promise.all(outputsToSend.map(async (out) => {
        const id = out.nodePath;
        const state = await this.getStateAsync(id);
        if (!state) {
          return null;
        }
        return state.val * out.fac;
      }));
      let index = values.findIndex((s) => s == null);
      while (index != -1) {
        values.splice(index, 1);
        outputsToSend.splice(index, 1);
        index = values.findIndex((s) => s == null);
      }
      this.sendMultipleOutputs(outputsToSend, values);
    }
  }
  sendMultipleOutputs(outputs, values) {
    const buffer = Buffer.alloc(4 + 8 * outputs.length);
    buffer[0] = 2;
    buffer[1] = 0;
    buffer[2] = 4 + 8 * outputs.length;
    buffer[3] = outputs.length;
    for (let i = 0; i < outputs.length; i++) {
      const output = outputs[i];
      buffer[4 + 8 * i + 0] = output.node;
      buffer[4 + 8 * i + 1] = output.output - 1;
      buffer[4 + 8 * i + 2] = output.analog ? 1 : 0;
      buffer[4 + 8 * i + 3] = output.analog ? output.unit : 43;
      let value = values[i] >>> 0;
      buffer.writeUInt32LE(value, 4 + 8 * i + 4);
    }
    this.log.debug(`sending ${buffer.toString("hex")} to ${this.cmiIP}:${this.config.cmiPort}...`);
    this.sock.send(buffer, this.config.cmiPort, this.config.cmiIP, (err) => {
      if (err != null) {
        this.log.error("error sending: " + err);
      }
    });
  }
  async sendState(output, id, state) {
    if (state.val == null) {
      this.log.warn(`cannot send null value (${id})`);
      return;
    }
    const success = this.send(
      output.node,
      output.output,
      output.analog ? output.unit : 43,
      output.analog ? parseInt(state.val.toString()) * output.fac : state.val ? 1 : 0
    );
    if (success) {
      this.setState(id, state.val, success);
    }
  }
  async sendOutput(output) {
    const id = `out.node${output.node}.${output.analog ? "analog" : "digital"}${output.output}`;
    const state = await this.getStateAsync(id);
    if (!state) {
      this.log.warn(`state for output ${id} does not exist. Please restart adapter`);
      return;
    }
    await this.sendState(output, id, state);
  }
  coeReceived(msg, rinfo) {
    this.lastSent = Date.now();
    this.log.debug(`received ${msg.toString("hex")} from ${rinfo.address}`);
    this.handlePacket(msg);
  }
  onUnload(callback) {
    try {
      if (this.sendInterval) this.clearInterval(this.sendInterval);
      this.sock.close();
      this.unsubscribeStates("*");
      callback();
    } catch (e) {
      callback();
    }
  }
  outputFromId(id) {
    return this.outputs.find((output) => id.endsWith(output.nodePath)) || null;
  }
  inputFromId(id) {
    return this.inputs.find((input) => id.endsWith(input.nodePath)) || null;
  }
  onStateChange(id, state) {
    if (state) {
      if (state.ack) return;
      const output = this.outputFromId(id);
      if (output == null) return;
      this.sendState(output, id, state);
    }
  }
  // data types adapted from pyton-can-coe (Copyright (c) 2016-2025, Gerrit Beine)
  // https://c0d3.sh/smarthome/python-can-coe/src/branch/main/coe/coe.py 
  dataTypes = {
    0: "",
    1: "\xB0C",
    2: "W/m\xB2",
    3: "l/h",
    4: "sec",
    5: "min",
    7: "K",
    8: "%",
    9: "kW",
    10: "MWh",
    11: "kWh",
    12: "V",
    13: "mA",
    14: "h",
    15: "d",
    18: "km/h",
    19: "Hz",
    20: "l/m",
    21: "bar",
    43: "(bool)",
    69: "W"
  };
  async handlePacket(packet) {
    if (packet.readUint8() != 2) {
      this.log.warn(`invalid packet received. Cannot handle: ${packet.toString("hex")}`);
      return;
    }
    const length = packet.readUInt8(2);
    const messageCount = packet.readUint8(3);
    if (length != 4 + messageCount * 8) {
      this.log.warn(`invalid packet received. Cannot handle: ${packet.toString("hex")}`);
      return;
    }
    for (let i = 0; i < messageCount; i++) {
      const nodeID = packet.readUint8(8 * i + 4);
      const outID = packet.readUint8(8 * i + 5) + 1;
      const digital = packet.readUint8(8 * i + 6) == 0;
      const dataType = packet.readUint8(8 * i + 7);
      const data = packet.readUint32LE(8 * i + 8);
      let typ = "(unknown)";
      if (dataType in this.dataTypes) {
        typ = this.dataTypes[dataType];
      }
      this.log.debug(`received data from node ${nodeID}/${outID}: ${data} ${typ}`);
      if (!this.isInputCreated(nodeID, digital, outID)) {
        this.log.warn(`Received from ${nodeID}/${digital ? "d" : "a"}${outID}, but there is no input created`);
        continue;
      }
      const input = this.inputs.find((i2) => i2.node == nodeID && i2.analog == !digital && i2.output == outID);
      if (this.dataTypes[input.unit] != typ && input.analog) {
        this.log.warn(`${input.node}/a${input.output} has wrong unit (received ${typ} but should have been ${this.dataTypes[input.unit]})`);
      }
      const id = input.nodePath;
      this.setState(id, digital ? data == 1 ? true : false : data * input.fac, true);
    }
  }
  isInputCreated(nodeID, digital, outID) {
    return this.inputs.some((i) => i.node == nodeID && i.analog == !digital && i.output == outID);
  }
  send(nodeID, outID, dataType, data) {
    if (this.cmiIP == "") return false;
    if (nodeID > 255 || nodeID < 0) {
      this.log.warn(`NodeID has to be between 0 and 255 (got ${nodeID})!`);
      return false;
    }
    if (outID <= 0) {
      this.log.warn(`Output ID has to be greater than 0 (got ${outID})!`);
      return false;
    }
    const array = new Uint8Array(8);
    array[0] = 2;
    array[1] = 0;
    array[2] = 12;
    array[3] = 1;
    array[4] = nodeID;
    array[5] = outID - 1;
    array[6] = dataType == 43 ? 0 : 1;
    array[7] = dataType;
    const buffer = Buffer.alloc(12);
    buffer.fill(array);
    data = data >>> 0;
    buffer.writeUint32LE(data, 8);
    this.log.debug(`sending ${buffer.toString("hex")} to ${this.cmiIP}:${this.config.cmiPort}`);
    this.sock.send(buffer, this.config.cmiPort, this.cmiIP, (err) => {
      if (err != null) {
        this.log.error(`error sending: ${err}`);
      }
    });
    return true;
  }
}
if (require.main !== module) {
  module.exports = (options) => new Cmicoe(options);
} else {
  (() => new Cmicoe())();
}
//# sourceMappingURL=main.js.map
