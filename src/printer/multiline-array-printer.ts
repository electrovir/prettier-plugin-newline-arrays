import type {AnyFunction} from '@augment-vir/common';
import {Node} from 'estree';
import {AstPath, ParserOptions, Printer} from 'prettier';
import {MultilineArrayOptions, envDebugKey, fillInOptions} from '../options.js';
import {printWithMultilineArrays} from './insert-new-lines.js';
import {getOriginalPrinter} from './original-printer.js';

const debug = !!process.env[envDebugKey];

function wrapInOriginalPrinterCall<T extends string = string>(
    property: keyof Printer,
    subProperty?: T,
) {
    return (...args: any[]) => {
        const originalPrinter = getOriginalPrinter();

        if (property === 'print') {
            const path = args[0] as AstPath;
            const options = args[1] as ParserOptions;
            const originalOutput = originalPrinter.print.call(
                originalPrinter,
                path,
                options,
                ...(args.slice(2) as [any]),
            );
            if (
                (options.filepath as string | undefined)?.endsWith('package.json') &&
                options.plugins.some(
                    (plugin) =>
                        typeof plugin === 'object' &&
                        (plugin as {name?: string}).name?.includes('prettier-plugin-packagejson'),
                )
            ) {
                return originalOutput;
            }

            const multilineOptions: MultilineArrayOptions & ParserOptions = fillInOptions(options);

            const multilinePrintedOutput = printWithMultilineArrays(
                originalOutput,
                args[0],
                multilineOptions,
                debug,
            );
            return multilinePrintedOutput;
        } else {
            let thisParent: any = originalPrinter;
            let printerProp = originalPrinter[property];
            if (subProperty) {
                thisParent = printerProp;
                printerProp = (printerProp as any)[subProperty];
            }
            try {
                return (printerProp as AnyFunction | undefined)?.apply(thisParent, args);
            } catch (error) {
                const newError = new Error(
                    `Failed to wrap JS printer call for property "${property}" ${
                        subProperty ? `and subProperty "${subProperty}"` : ''
                    }: \n`,
                );
                if (error instanceof Error && error.stack) {
                    newError.stack = newError.message + error.stack;
                }
                throw newError;
            }
        }
    };
}

const handleComments: Printer['handleComments'] = {
    endOfLine: wrapInOriginalPrinterCall<keyof NonNullable<Printer['handleComments']>>(
        'handleComments',
        'endOfLine',
    ),
    ownLine: wrapInOriginalPrinterCall<keyof NonNullable<Printer['handleComments']>>(
        'handleComments',
        'ownLine',
    ),
    remaining: wrapInOriginalPrinterCall<keyof NonNullable<Printer['handleComments']>>(
        'handleComments',
        'remaining',
    ),
};

/** This is a proxy because the original printer is only set at run time. */
export const multilineArrayPrinter = new Proxy<Printer<Node>>({} as Printer<Node>, {
    get: (target, property: keyof Printer) => {
        // @ts-expect-error: the avoidAstMutation property is not defined in the types
        if (property === 'experimentalFeatures') {
            return {
                avoidAstMutation: true,
            };
        }

        /**
         * "handleComments" is the only printer property which isn't a callback function, so for
         * simplicity, ignore it.
         */
        if (property === 'handleComments') {
            return handleComments;
        }

        const originalPrinter = getOriginalPrinter();
        if (originalPrinter[property] === undefined) {
            return undefined;
        }

        /**
         * We have to return a callback so that we can extract the jsPlugin from the options
         * argument
         */
        return wrapInOriginalPrinterCall(property);
    },
});
