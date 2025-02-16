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
  }
  sock;
  outputs;
  lastSent = 0;
  sendInterval = void 0;
  cmiIP = "";
  async onReady() {
    this.setState("info.connection", false, true);
    this.cmiIP = this.config.cmiIP;
    if (this.cmiIP == "") {
      this.log.error("IP of cmi not specified! Cannot send!");
    }
    this.log.debug("config nodes: " + this.config.nodes);
    try {
      const outputs = this.config.nodes.split(",");
      for (let idx = 0; idx < outputs.length; idx++) {
        const output = outputs[idx];
        const regex = /^(\d+)\/(\w)(\d+)$/;
        const matches = output.match(regex);
        if (matches == null) {
          this.log.warn(`match ${output} has wrong format (no match)!`);
          continue;
        }
        this.log.debug(`${matches[0]}: ${matches[1]}, ${matches[2]}, ${matches[3]}`);
        let digital = false;
        if (matches[2].toLowerCase() == "d")
          digital = true;
        else if (matches[2].toLowerCase() == "a")
          digital = false;
        else {
          this.log.warn(`configurated node ${output} has wrong format!`);
          continue;
        }
        const out = {
          node: parseInt(matches[1]),
          output: parseInt(matches[3]),
          analog: !digital
        };
        this.outputs.push(out);
      }
    } catch (e) {
      this.log.error("Nodes setting has the wrong format!");
    }
    await this.delUnusedNodes();
    for (let idx = 0; idx < this.outputs.length; idx++) {
      const output = this.outputs[idx];
      const id = `out.node${output.node}.${output.analog ? "analog" : "digital"}${output.output}`;
      const obj = {
        type: "state",
        common: {
          type: output.analog ? "number" : "boolean",
          read: true,
          write: true,
          role: "",
          name: `Node ${output.node}/${output.output}`,
          def: output.analog ? 0 : false
        },
        native: {},
        _id: id
      };
      this.log.debug(`creating state with id ${id}...`);
      await this.setObjectNotExistsAsync(id, obj);
    }
    if (this.config.sendOnChange) {
      this.log.debug(`subscribing to states`);
      this.subscribeStates("out.node*");
    }
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
    });
    this.sock.on("error", (err) => {
      this.log.error(`socket error: ${err}`);
    });
    this.sock.bind(5442, "0.0.0.0");
    this.sendInterval = setInterval(() => this.sendOutputs(), this.config.sendInterval * 1e3);
    await this.sendOutputs();
  }
  async delUnusedNodes() {
    const states = await this.getStatesAsync("out.*");
    for (const s in states) {
      const output = this.outputFromId(s);
      if (output == null) {
        continue;
      }
      if (!this.outputs.some(
        (o) => o.node == output.node && o.analog == output.analog && output.output == output.output
      )) {
        this.log.warn(`state ${s} is no longer used. Deleting...`);
        await this.delObjectAsync(s);
      }
    }
  }
  async sendOutputs() {
    if (this.lastSent > (/* @__PURE__ */ new Date()).getTime() + 18e5) {
      this.setStateChanged("timeout", true, true);
      this.setStateChanged("info.connection", false, true);
    } else {
      this.setStateChanged("timeout", false, true);
      this.setStateChanged("info.connection", true, true);
    }
    for (let idx = 0; idx < this.outputs.length; idx++) {
      const output = this.outputs[idx];
      await this.sendOutput(output);
    }
  }
  async sendOutput(output) {
    const id = `out.node${output.node}.${output.analog ? "analog" : "digital"}${output.output}`;
    const state = await this.getStateAsync(id);
    if (!state) {
      this.log.warn(`state for output ${id} does not exist. Please restart adapter`);
      return;
    }
    if (state.ack)
      return;
    if (state.val == null) {
      this.log.warn(`cannot send null value (${id})`);
      return;
    }
    const success = this.send(
      output.node,
      output.output,
      output.analog ? 0 : 43,
      output.analog ? parseInt(state.val.toString()) : state.val ? 1 : 0
    );
    if (success) {
      this.setState(id, state.val, success);
    }
  }
  coeReceived(msg, rinfo) {
    this.lastSent = (/* @__PURE__ */ new Date()).getTime();
    this.log.debug(`received ${msg.toString("hex")} from ${rinfo.address}`);
    this.handlePacket(msg);
  }
  onUnload(callback) {
    try {
      if (this.sendInterval)
        clearInterval(this.sendInterval);
      this.sock.close();
      this.unsubscribeStates("*");
      callback();
    } catch (e) {
      callback();
    }
  }
  outputFromId(id) {
    const regex = /node(\d+).(digital|analog)(\d+)$/;
    const match = id.match(regex);
    if (match == null) {
      this.log.warn(`node with wrong id found: ${id}. Skipping`);
      return null;
    }
    const output = {
      node: parseInt(match[1]),
      output: parseInt(match[3]),
      analog: match[2] == "analog"
    };
    return output;
  }
  onStateChange(id, state) {
    console.warn("state changed: " + id);
    if (state) {
      if (state.ack)
        return;
      const output = this.outputFromId(id);
      if (output == null)
        return;
      this.sendOutput(output);
    }
  }
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
  handlePacket(packet) {
    const nodeID = packet.readInt8(4);
    const outID = packet.readInt8(5) + 1;
    const dataType = packet.readInt8(7);
    const data = packet.readUint32LE(8);
    let typ = "(unknown)";
    if (dataType in this.dataTypes) {
      typ = this.dataTypes[dataType];
    }
    this.log.debug(`received data from node ${nodeID}/${outID}: ${data} ${typ}`);
    let digital = false;
    if (dataType == 43) {
      digital = true;
    }
    const id = "in.node" + nodeID + "." + (digital ? "digital" : "analog") + outID;
    const obj = {
      type: "state",
      common: {
        type: digital ? "boolean" : "number",
        read: true,
        write: false,
        role: "",
        name: `Node ${nodeID}/${outID}`
      },
      native: {},
      _id: id
    };
    this.setObjectNotExists(id, obj, () => {
      this.setState(id, digital ? data == 1 ? true : false : data, true);
    });
  }
  send(nodeID, outID, dataType, data) {
    if (this.cmiIP == "")
      return false;
    if (nodeID > 255 || nodeID < 0) {
      this.log.warn(`NodeID has to be between 0 and 255 (got ${nodeID})!`);
      return false;
    }
    if (outID <= 0) {
      this.log.warn(`Out ID has to be greater than 0 (got ${outID})!`);
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
    buffer.writeUint32LE(data, 8);
    this.log.debug(`sending ${buffer.toString("hex")} to ${this.cmiIP}`);
    this.sock.send(buffer, 5442, this.cmiIP, (err) => {
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
