"use strict"
import * as child_process from "child_process";

export class PythonEval {
    child: child_process.ChildProcess;
    path: string | null;

    constructor(path: string | null) {
        this.path = path;
        this.run();
    }

    run() {
        if (this.path && this.path.length > 0) {
            this.child = child_process.spawn('python', ['-i', this.path]);
        } else {
            this.child = child_process.spawn('python', ['-i']);
        }

        // Process any initial info
        this.child.stderr?.on('data', this.processError);
        this.child.stdout?.on('data', this.processOutput);

        // Make stdout always spit out proper newlines
        this.feedInput('import sys;__stdout__=sys.stdout.write;sys.stdout.write=lambda text:__stdout__(text.replace(\'\\\\n\',\'\\n\'))')
    }

    processOutput(data: object) {
    }

    processError(data: object) {
    }

    stop() {
        this.child.kill();
    }

    restart() {
        this.stop();
        this.run();
    }

    async assignVariable(name: string, content: string) {
        const code = `${name} = ''${content}''`;
        await this.exec(code);
    }

    exec(input: string, timeout: number = 2500) {
        if (this.child.stdin?.destroyed || this.child.killed) {
            return new Promise<object>(resolve => {
                resolve({
                    output: null,
                    error: 'InlinePython: failed to launch Python interpreter.\nPython may not be installed on your system.'
                })
            });
        }

        return new Promise<object>(resolve => {
            this.child.stdout?.once('data', function(data) {
                resolve({
                    output: PythonEval.stripOutput(data.toString()),
                    error: null
                });
            });

            this.child.stderr?.once('data', function(data) {
                const error = PythonEval.stripOutput(data.toString());
                if (!error.startsWith("...")) {
                    if (error.startsWith(">>>")) {
                        resolve({
                            output: '',
                            error: null
                        });
                    } else {
                        resolve({
                            output: null,
                            error: error.replace(/>>> /g, '').trim()
                        });
                    }
                }
            });

            setTimeout(function() {
                resolve({
                    output: null,
                    error: 'InlinePython: did not get result in the timeout window.\nThe query took too long to execute or could not be executed.'
                });
            }, timeout);

            this.feedInput(input);
        });
    }

    feedInput(input: string) {
        this.child.stdin?.cork();
        this.child.stdin?.write(input + '\r\n\r\n');
        this.child.stdin?.uncork();
    }

    private static stripOutput(output: string) {
        if (output.length > 0 && output[output.length - 1] == '\n') {
            output = output.slice(0, -1);
        }

        if (output.length > 0 && output[output.length - 1] == '\r') {
            output = output.slice(0, -1);
        }

        if (output.length > 1) {
            if ((output[0] == '\'' && output[output.length - 1] == '\'') || (output[0] == '\"' && output[output.length - 1] == '\"')) {
                return output.slice(1, -1);
            }
        }

        return output;
    }
}