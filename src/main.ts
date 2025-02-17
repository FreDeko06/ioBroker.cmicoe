/*
 * Created with @iobroker/create-adapter v2.6.5
 */

import * as utils from "@iobroker/adapter-core";
import socket from "dgram";

type Output = {
	node: number;
	analog: boolean;
	output: number;
};

class Cmicoe extends utils.Adapter {
	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({
			...options,
			name: "cmicoe",
		});
		this.sock = socket.createSocket("udp4");
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		this.on("unload", this.onUnload.bind(this));
		this.outputs = [];
	}

	private sock: socket.Socket;
	private socketConnected: boolean = false;

	private outputs: Output[];

	private lastSent: number = 0;

	private sendInterval: ioBroker.Interval | undefined = undefined;

	private cmiIP: string = "";

	private async onReady(): Promise<void> {
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
				if (output == "") continue;
				const regex = /^(\d+)\/(\w)(\d+)$/;
				const matches: RegExpMatchArray | null = output.match(regex);
				if (matches == null) {
					this.log.warn(`output configuration "${output}" has wrong format (no match)!`);
					continue;
				}
				let digital: boolean = false;
				if (matches[2].toLowerCase() == "d") digital = true;
				else if (matches[2].toLowerCase() == "a") digital = false;
				else {
					this.log.warn(`configurated node ${output} has wrong format!`);
					continue;
				}
				const out: Output = {
					node: parseInt(matches[1]),
					output: parseInt(matches[3]),
					analog: !digital,
				};
				if (!this.outputs.some(o => o.analog == out.analog && o.node == out.node && o.output == out.output))
					this.outputs.push(out);
			}
		} catch (e) {
			this.log.error("Nodes setting has the wrong format!");
		}

		await this.delUnusedNodes();

		await this.createStates();

		if (this.config.bind == "") {
			this.log.error("No bind ip specified. Cannot listen!");
		} else {
			this.initSocket();
		}

		this.sendInterval = this.setInterval(() => {
			try {
				this.sendOutputs();
			} catch (e) {
				this.log.error("error sending outputs: " + e);
			}
		}, this.config.sendInterval * 1000);
		await this.sendOutputs();
	}

	private initSocket(): void {
		this.sock.on("message", (msg: Buffer, rinfo: socket.RemoteInfo) => {
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
					"this could be caused by another instance of this adapter running. Make sure to only start one instance of this adapter.",
				);
			}
		});

		this.sock.bind(this.config.port, this.config.bind);
	}

	private async delUnusedNodes(): Promise<void> {
		const states = await this.getStatesAsync("out.*");
		for (const s in states) {
			const output: Output | null = this.outputFromId(s);
			if (output == null) {
				continue;
			}
			if (
				!this.outputs.some(
					(o) => o.node == output.node && o.analog == output.analog && output.output == output.output,
				)
			) {
				this.log.warn(`state ${s} is no longer used. Deleting...`);
				await this.delObjectAsync(s);
			}
		}
	}

	private async createStates(): Promise<void> {
		for (let idx = 0; idx < this.outputs.length; idx++) {
			const output = this.outputs[idx];
			const id = `out.node${output.node}.${output.analog ? "analog" : "digital"}${output.output}`;
			const nodeChannel = `out.node${output.node}`;
			const nodeObj: ioBroker.Object = {
				type: "channel",
				common: {
					name: `Node ${output.node}`
				},
				native: {},
				_id: nodeChannel,
			};
			await this.setObjectNotExistsAsync(nodeChannel, nodeObj);

			const obj: ioBroker.StateObject = {
				type: "state",
				common: {
					type: output.analog ? "number" : "boolean",
					read: true,
					write: true,
					role: "value",
					name: `Output ${output.node}/${output.output}`,
					def: output.analog ? 0 : false,
				},
				native: {},
				_id: id,
			};
			this.log.debug(`creating state with id ${id}...`);
			await this.setObjectNotExistsAsync(id, obj);
		}
		if (this.config.sendOnChange) {
			this.log.debug(`subscribing to states`);
			this.subscribeStates("out.node*");
		}
	}

	private timeout: boolean = false;

	private async sendOutputs(): Promise<void> {
		if (this.lastSent > Date.now() + 1.8e6) {
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
			// get all outputs that can be sent in the same packet
			const allOutputs = outputsLeft.filter(o => o.node == output.node && o.analog == output.analog);
			// take a maximum of 4 of them
			const outputsToSend = allOutputs.slice(0, Math.min(4, allOutputs.length));

			// remove these from the outputsLeft list
			outputsLeft = outputsLeft.filter((out) => {
				return !outputsToSend.some(o => o.analog == out.analog && o.node == out.node && o.output == out.output);
			});

			// get the values
			const values = await Promise.all(outputsToSend.map(async (out) => {
				const id = `out.node${out.node}.${out.analog ? "analog" : "digital"}${out.output}`;
				const state = await this.getStateAsync(id);
				if (!state) {
					return null;
				}
				return state.val as number;
			}));

			// remove the null values
			let index = values.findIndex((s) => s == null);
			while (index != -1) {
				values.splice(index, 1);
				outputsToSend.splice(index, 1);

				index = values.findIndex((s) => s == null);
			}

			// send
			this.sendMultipleOutputs(outputsToSend, values as number[]);
		}
	}

	private sendMultipleOutputs(outputs: Output[], values: number[]): void {
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
			buffer[4 + 8 * i + 3] = output.analog ? 0x0 : 0x2b;
			buffer.writeUInt32LE(values[i] < 0 ? 0xFFFFFFFF * (values[i] + 1) : values[i], 4 + 8 * i + 4);
		}

		this.log.debug(`sending ${buffer.toString("hex")} to ${this.cmiIP}:${this.config.cmiPort}...`);

		this.sock.send(buffer, this.config.cmiPort, this.config.cmiIP, (err) => {
			if (err != null) {
				this.log.error("error sending: " + err);
			}
		});
	}

	private async sendState(output: Output, id: string, state: ioBroker.State): Promise<void> {
		if (state.val == null) {
			this.log.warn(`cannot send null value (${id})`);
			return;
		}
		const success = this.send(
			output.node,
			output.output,
			output.analog ? 0x00 : 0x2b,
			output.analog ? parseInt(state.val.toString()) : state.val ? 1 : 0,
		);
		if (success) {
			this.setState(id, state.val, success);
		}
	}

	private async sendOutput(output: Output): Promise<void> {
		const id = `out.node${output.node}.${output.analog ? "analog" : "digital"}${output.output}`;
		const state = await this.getStateAsync(id);
		if (!state) {
			this.log.warn(`state for output ${id} does not exist. Please restart adapter`);
			return;
		}
		await this.sendState(output, id, state);
	}

	private coeReceived(msg: Buffer, rinfo: socket.RemoteInfo): void {
		this.lastSent = Date.now();
		this.log.debug(`received ${msg.toString("hex")} from ${rinfo.address}`);
		this.handlePacket(msg);
	}

	private onUnload(callback: () => void): void {
		try {
			if (this.sendInterval) this.clearInterval(this.sendInterval);
			this.sock.close();
			this.unsubscribeStates("*");

			callback();
		} catch (e) {
			callback();
		}
	}

	private outputFromId(id: string): Output | null {
		const regex = /node(\d+).(digital|analog)(\d+)$/;
		const match: RegExpMatchArray | null = id.match(regex);
		if (match == null) {
			this.log.warn(`node with wrong id found: ${id}. Skipping`);
			return null;
		}
		const output: Output = {
			node: parseInt(match[1]),
			output: parseInt(match[3]),
			analog: match[2] == "analog",
		};
		return output;
	}

	private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
		if (state) {
			if (state.ack) return;
			const output = this.outputFromId(id);
			if (output == null) return;

			this.sendState(output, id, state);
		}
	}

	// data types adapted from pyton-can-coe (Copyright (c) 2016-2025, Gerrit Beine)
	// https://c0d3.sh/smarthome/python-can-coe/src/branch/main/coe/coe.py 
	private dataTypes: { [id: number]: string } = {
		0: "",
		1: "°C",
		2: "W/m²",
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
		69: "W",
	};

	private inputs: Output[] = [];

	private async handlePacket(packet: Buffer): Promise<void> {
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
			const digital: boolean = packet.readUint8(8 * i + 6) == 0;
			const dataType = packet.readUint8(8 * i + 7);
			const data = packet.readUint32LE(8 * i + 8);

			let typ = "(unknown)";
			if (dataType in this.dataTypes) {
				typ = this.dataTypes[dataType];
			}

			this.log.debug(`received data from node ${nodeID}/${outID}: ${data} ${typ}`);

			if (!this.isNodeCreated(nodeID)) {
				const nodeChannel = `in.node${nodeID}`;
				const nodeObj: ioBroker.Object = {
					type: "channel",
					common: {
						name: `Node ${nodeID}`
					},
					native: {},
					_id: nodeChannel
				};
				await this.setObjectNotExistsAsync(nodeChannel, nodeObj);
			}

			const id = "in.node" + nodeID + "." + (digital ? "digital" : "analog") + outID;
			const obj: ioBroker.StateObject = {
				type: "state",
				common: {
					type: digital ? "boolean" : "number",
					read: true,
					write: false,
					role: "",
					name: `Input ${nodeID}/${outID}`,
				},
				native: {},
				_id: id,
			};
			if (!this.inputs.some(i => i.analog != digital && i.node == nodeID && i.output == outID)) {
				await this.setObjectNotExistsAsync(id, obj);
				this.inputs.push({ node: nodeID, output: outID, analog: !digital });
			}
			this.setState(id, digital ? (data == 1 ? true : false) : data, true);
		}

	}

	private isNodeCreated(nodeID: number): boolean {
		for (let i = 0; i < this.inputs.length; i++) {
			if (this.inputs[i].node == nodeID) return true;
		}
		return false;
	}

	private send(nodeID: number, outID: number, dataType: number, data: number): boolean {
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
		array[6] = dataType == 0x2b ? 0 : 1;
		array[7] = dataType;

		const buffer = Buffer.alloc(12);
		buffer.fill(array);

		// convert negative numbers
		if (data < 0) {
			data = 0xFFFFFFFF + (data + 1);
		}
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
	// Export the constructor in compact mode
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Cmicoe(options);
} else {
	// otherwise start the instance directly
	(() => new Cmicoe())();
}
