import { Command } from 'commander';
export declare function assertPersonAtTerminal(command: 'link' | 'join', stdin?: {
    isTTY?: boolean;
}, stdout?: {
    isTTY?: boolean;
}): void;
export declare function registerNetworkCommand(program: Command, networkDistDir: URL): void;
//# sourceMappingURL=command.d.ts.map