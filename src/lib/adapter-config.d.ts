// This file extends the AdapterConfig type from "@types/iobroker"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
	namespace ioBroker {
		interface AdapterConfig {
			nodes: string;
			cmiIP: string;
			cmiPort: number;
			sendInterval: number;
			sendOnChange: boolean;
			bind: string;
			port: number;
			outputs: Output[];
			inputs: Output[];
		}
	}
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export { };

