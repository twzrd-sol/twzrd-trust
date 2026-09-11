import type { AgentCommerceLoop, CreateLoopInput, Decision } from "./types.js";
export interface SimulationOptions {
    input: CreateLoopInput;
    decision: Decision;
    paymentSucceeds?: boolean;
    deliverySucceeds?: boolean;
}
export declare function simulate(options: SimulationOptions): {
    loop: AgentCommerceLoop;
    signerInvocations: number;
};
