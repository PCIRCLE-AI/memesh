import { Command } from 'commander';
export declare function assertPersonAtTerminal(command: 'link' | 'join', stdin?: {
    isTTY?: boolean;
}, stdout?: {
    isTTY?: boolean;
}): void;
export declare function promptForLink(stdin?: NodeJS.ReadStream, stderr?: NodeJS.WritableStream): Promise<string>;
export declare function action<A extends unknown[]>(run: (...args: A) => void | Promise<void>): (...args: A) => Promise<void>;
export declare function registerNetworkCommand(program: Command, networkDistDir: URL): void;
//# sourceMappingURL=command.d.ts.map