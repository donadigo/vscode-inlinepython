"use strict"
import * as vscode from 'vscode';
import { PythonEval } from "./eval";

const MAX_CONTENT_LENGTH: number = 100;

let decorationType: vscode.TextEditorDecorationType | null = null;
let errorDecorationType: vscode.TextEditorDecorationType | null = null;
let currentCodePosition: vscode.Position | null = null;
let insertSelection: vscode.Selection | null = null;
let errorEndPosition: vscode.Position | null = null;
let pyEval: PythonEval | null = null;
let submitLock: boolean = false;

function getConfig() {
    return vscode.workspace.getConfiguration('inlinepython');
}

export function activate(context: vscode.ExtensionContext) {
    pyEval = new PythonEval(getConfig().get('preloadScriptPath') ?? null);

    const disposable = vscode.commands.registerCommand('inlinepython.insert', () => {
        if (vscode.window.activeTextEditor) {
            decorate(vscode.window.activeTextEditor);
        }
    });
    
    vscode.workspace.onDidChangeTextDocument(onTextChanged);
    vscode.workspace.onWillSaveTextDocument(onWillSaveDocument);

	context.subscriptions.push(disposable);
}

export function deactivate() {
    pyEval?.stop();
}

function onWillSaveDocument(event: vscode.TextDocumentWillSaveEvent) {
    if (decorationType && currentCodePosition) {
        decorationType.dispose();
        if (vscode.window.activeTextEditor?.document.uri == event.document.uri) {
            const promise = cleanupAll(vscode.window.activeTextEditor);
            event.waitUntil(promise);
        }
    }
}

function onTextChanged(event: vscode.TextDocumentChangeEvent) {
    if (currentCodePosition == null || insertSelection == null || submitLock) {
        return;
    }

    if (event.contentChanges.length == 1) {
        const change = event.contentChanges[0];
        if (change.text.indexOf('\n') != -1) {
            if (change.range.start.line == currentCodePosition.line) {
                onSubmitCurrentPosition();
            } else if (change.range.start.line < currentCodePosition.line) {
                moveAll(1);
            }
        } else if (change.range.start.line < currentCodePosition.line && change.text.length == 0) {
            moveAll(-1);
        }
    }
}

function moveAll(lineDelta: number) {
    if (currentCodePosition) {
        currentCodePosition = currentCodePosition.translate(lineDelta, 0);
    }

    if (insertSelection) {
        insertSelection = new vscode.Selection(insertSelection.start.translate(lineDelta, 0), insertSelection.end.translate(lineDelta, 0));
    }

    if (errorEndPosition) {
        errorEndPosition = errorEndPosition.translate(lineDelta, 0);
    }
}

function addSlashes(str: string) {
    return (str + '').replace(/[\\"']/g, '\\$&').replace(/\u0000/g, '\\0');
}

function prepareSelectionForEdit(selectionText: string) {
    if (isNaN(Number(selectionText))) {
        return `'${addSlashes(selectionText)}'`;
    }

    return selectionText;
}

async function decorate(editor: vscode.TextEditor) {
    if (decorationType) {
        decorationType.dispose();
    }

    decorationType = vscode.window.createTextEditorDecorationType({
        before: {
            backgroundColor: "#ffe873",
            color: "black",
            contentText: "Python Code",
            margin: "0 10px 0 0",
            border: "2px solid #ffe873"
        },
    
        backgroundColor: "rgba(75, 139, 190, 0.4)",
        isWholeLine: true,
        border: "2px solid rgba(255, 232, 115, 0.5)"
    });

    insertSelection = editor.selection;

    const position = new vscode.Position(editor.selection.start.line, 0);
    if (editor.document.lineAt(position).text.trim().length > 0) {
        await editor.edit(editBuilder => {
            editBuilder.insert(position, '\n');
        });
    }

    let text = '';
    if (editor.selection.start.line == editor.selection.end.line && editor.selection.start.character != editor.selection.end.character) {
        const range = new vscode.Range(editor.selection.start, editor.selection.end);
        text = prepareSelectionForEdit(editor.document.getText(range));

        if (text.length > MAX_CONTENT_LENGTH) {
            pyEval?.assignVariable('content', text);
            text = 'content'
        }
    } else if (editor.selection.start.line != editor.selection.end.line) {
        text = prepareSelectionForEdit(editor.document.getText(editor.selection));
        
        pyEval?.assignVariable('content', text);
        text = 'content';
    }

    await editor.edit(editBuilder => {
        editBuilder.insert(position, text);
    });

    editor.selection = new vscode.Selection(position, position.translate(0, text.length));

    const range = new vscode.Range(position, position);
    let decorationsArray: vscode.DecorationOptions[] = [];
    decorationsArray.push({ range });
    editor.setDecorations(decorationType, decorationsArray);

    currentCodePosition = position;
}

async function onSubmitCurrentPosition() {
    if (currentCodePosition == null || insertSelection == null) {
        return;
    }

    const editor = vscode.window.activeTextEditor;
    if (editor == null) {
        return;
    }

    // Undo the enter, there are a lot of cases so we don't do this manually
    submitLock = true;
    await vscode.commands.executeCommand('undo');
    submitLock = false;

    let line = editor.document.lineAt(currentCodePosition.line);

    await removeLastError(editor);
    currentCodePosition = null;

    let output = '';
    if (line?.text.trim().length > 0) {
        const timeout = Number(getConfig().get('execTimeout'));
        const result = await pyEval?.exec(line?.text, timeout);
        if (result.output != null) {
            output = result.output;
        } else {
            await showError(editor, line.range.end, result.error);
            return;
        }
    }

    decorationType?.dispose();

    await editor.edit(editBuilder => {
        const range = new vscode.Range(line.range.start, new vscode.Position(line.range.start.line + 1, 0));
        editBuilder.delete(range);
    });

    if (output.length > 0) {
        await editor.edit(editBuilder => {
            editBuilder.delete(insertSelection);
            editBuilder.insert(insertSelection.start, output);
        });
    }

    const newCursorPosition = insertSelection.start.translate(0, output.length);
    editor.selection = new vscode.Selection(newCursorPosition, newCursorPosition);
    insertSelection = null;
}

async function cleanupAll(editor: vscode.TextEditor) {
    await removeLastError(editor);
    await cleanupNewline(editor);

    currentCodePosition = null;
    insertSelection = null;
    decorationType = null;
}

async function cleanupNewline(editor: vscode.TextEditor) {
    if (currentCodePosition == null) {
        return;
    }

    let line = editor.document.lineAt(currentCodePosition.line);
    if (line == null) {
        return;
    }

    await editor.edit(editBuilder => {
        const end = new vscode.Position(line.range.end.line + 1, 0);
        editBuilder.delete(new vscode.Range(line.range.start, end));
    });
}

async function removeLastError(editor: vscode.TextEditor) {
    errorDecorationType?.dispose();
    if (errorEndPosition && currentCodePosition) {
        const line = editor.document.lineAt(currentCodePosition.line);
        await editor.edit(editBuilder => {
            editBuilder.delete(new vscode.Range(line.range.end, errorEndPosition));
        });

        errorEndPosition = null;
    }
}

async function showError(editor: vscode.TextEditor, position: vscode.Position, error: string) {
    errorDecorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor("inputValidation.errorBackground"),
        isWholeLine: true
    });

    const selection = editor.selection;

    await editor.edit(editBuilder => {
        editBuilder.insert(position, '\n' + error);
    });

    editor.selection = selection;

    const lines = error.split('\n');
    const start = new vscode.Position(position.line + 1, 0);
    errorEndPosition = editor.document.lineAt(position.line + lines.length).range.end;
    
    const range = new vscode.Range(start, errorEndPosition);

    let decorationsArray: vscode.DecorationOptions[] = [];
    decorationsArray.push({ range });
    editor.setDecorations(errorDecorationType, decorationsArray);

    currentCodePosition = position;
}