import {getObjectTypedKeys, stringify, Values, type AnyObject} from '@augment-vir/common';
import {AstPath, Doc, doc, ParserOptions} from 'prettier';
import {isDocCommand} from '../augments/doc.js';
import {MultilineArrayOptions} from '../options.js';
import {walkDoc} from './child-docs.js';
import {
    CommentTriggerWithEnding,
    getCommentTriggers,
    parseNextLineCounts,
} from './comment-triggers.js';
import {containsLeadingNewline} from './leading-new-line.js';
import {isArrayLikeNode} from './supported-node-types.js';
import {containsTrailingComma} from './trailing-comma.js';

const nestingSyntaxOpen = '[{(`';
const nestingSyntaxClose = ']})`';

const found = 'Found "[" but:';

function insertLinesIntoArray(
    inputDoc: Doc,
    manualWrap: boolean,
    lineCounts: number[],
    wrapThreshold: number,
    debug: boolean,
): Doc {
    walkDoc(inputDoc, debug, (currentDoc, parentDocs, childIndex): boolean => {
        const currentParent = parentDocs[0];
        const parentDoc = currentParent?.parent;
        if (typeof currentDoc === 'string' && currentDoc.trim() === '[') {
            const undoMutations: (() => void)[] = [];

            let finalLineBreakExists = false as boolean;

            function undoAllMutations() {
                undoMutations.toReversed().forEach((undoMutation) => {
                    undoMutation();
                });
            }

            if (!Array.isArray(parentDoc)) {
                if (debug) {
                    console.error({brokenParent: parentDoc, currentDoc});
                }
                throw new Error(`${found} parentDoc is not an array.`);
            }

            if (debug) {
                console.info({currentDoc, parentDoc});
                console.info(stringify(parentDoc));
            }
            if (childIndex !== 0) {
                /**
                 * This happens in some situations which we don't want to format in this plugin,
                 * like in type accessors:
                 *
                 * ```typescript
                 * type mockType = exampleObject['property'];
                 * ```
                 */
                return true;
            }

            const maybeBreak = parentDoc[childIndex + 2];
            if (isDocCommand(maybeBreak) && maybeBreak.type === 'if-break') {
                undoMutations.push(() => {
                    parentDoc[childIndex + 2] = maybeBreak;
                });
                parentDoc[childIndex + 2] = maybeBreak.breakContents;
            }
            const indentIndex = childIndex + 1;
            const bracketSibling =
                parentDoc[indentIndex] === '' ? parentDoc[indentIndex + 1] : parentDoc[indentIndex];
            if (debug) {
                console.info({bracketSibling});
            }
            if (bracketSibling === ']') {
                return false;
            }
            if (!isDocCommand(bracketSibling) || bracketSibling.type !== 'indent') {
                throw new Error(
                    `${found} its sibling was not an indent Doc.: ${stringify(bracketSibling)}`,
                );
            }
            const indentContents = bracketSibling.contents;
            if (debug) {
                console.info({indentContents});
            }
            if (!Array.isArray(indentContents)) {
                throw new TypeError(`${found} indent didn't have array contents.`);
            }
            if (indentContents.length < 2) {
                if (debug) {
                    console.error(stringify(indentContents));
                }
                throw new Error(`${found} indent contents did not have at least 2 children`);
            }

            const startingLine = indentContents[0];
            if (debug) {
                console.info({firstIndentContentsChild: startingLine});
            }
            if (!isDocCommand(startingLine) || startingLine.type !== 'line') {
                if (Array.isArray(startingLine)) {
                    undoAllMutations();
                    return false;
                } else {
                    throw new TypeError(`${found} first indent child was not a line.`);
                }
            }
            indentContents[0] = '';
            undoMutations.push(() => {
                indentContents[0] = startingLine;
            });

            const indentedContent = indentContents[1];

            if (debug) {
                console.info({
                    secondIndentContentsChild: indentedContent,
                    itsFirstChild: (indentedContent as any)[0],
                });
            }
            if (!indentedContent) {
                console.error('second indent child (indentedContent) is not defined:', {
                    indentContents,
                    indentedContent,
                });
                throw new Error(`${found} second indent child is not a fill.`);
            }

            if (
                !Array.isArray(indentedContent) &&
                !(isDocCommand(indentedContent) && indentedContent.type === 'fill')
            ) {
                console.error('second indent child (indentCode) is not a fill doc or an array:', {
                    indentContents,
                    indentCode: indentedContent,
                });
                throw new Error(`${found} second indent child is not a fill doc or an array.`);
            }

            if (
                Array.isArray(indentedContent)
                    ? indentedContent.length === 0
                    : indentedContent.parts.length === 0
            ) {
                throw new Error(`${found} indentedContent has no length.`);
            }

            // lineIndex is 0 indexed
            let lineIndex = 0;
            // columnCount is 1 indexed
            let columnCount = 1;

            if (debug) {
                console.info(`>>>>>>>>>>>>>> Walking children for commas`);
            }

            let arrayChildCount = 0;

            let forceFinalLineBreakExists = false as boolean;

            if (!finalLineBreakExists) {
                walkDoc(
                    indentedContent,
                    debug,
                    (currentDoc, commaParents, commaChildIndex): boolean => {
                        finalLineBreakExists = false;
                        const innerCurrentParent = commaParents[0];
                        const innerCurrentParentDoc = innerCurrentParent?.parent;
                        if (isDocCommand(currentDoc) && currentDoc.type === 'if-break') {
                            if (debug) {
                                console.info(`found final line break inside of if-break`);
                            }
                            finalLineBreakExists = true;
                            if (!innerCurrentParentDoc) {
                                throw new Error(`Found if-break without a parent`);
                            }
                            if (!Array.isArray(innerCurrentParentDoc)) {
                                throw new TypeError(`if-break parent is not an array`);
                            }
                            if (commaChildIndex == undefined) {
                                throw new Error(`if-break child index is undefined`);
                            }
                            innerCurrentParentDoc[commaChildIndex] = currentDoc.breakContents;
                            innerCurrentParentDoc.splice(
                                commaChildIndex + 1,
                                0,
                                doc.builders.breakParent,
                            );
                            undoMutations.push(() => {
                                innerCurrentParentDoc.splice(commaChildIndex + 1, 1);
                                innerCurrentParentDoc[commaChildIndex] = currentDoc;
                            });
                        } else if (typeof currentDoc === 'string') {
                            if (!innerCurrentParentDoc) {
                                console.error({innerParentDoc: innerCurrentParentDoc});
                                throw new Error(`Found string but innerParentDoc is not defined.`);
                            }
                            if (currentDoc && nestingSyntaxOpen.includes(currentDoc)) {
                                if (!Array.isArray(innerCurrentParentDoc)) {
                                    throw new TypeError(
                                        `Found opening syntax but parent is not an array.`,
                                    );
                                }
                                const closingIndex = innerCurrentParentDoc.findIndex(
                                    (sibling) =>
                                        typeof sibling === 'string' &&
                                        sibling &&
                                        nestingSyntaxClose.includes(sibling),
                                );
                                if (closingIndex < 0) {
                                    throw new Error(
                                        `Could not find closing match for ${currentDoc}`,
                                    );
                                }
                                // check that there's a line break before the ending of the array
                                if (innerCurrentParentDoc[closingIndex] !== ']') {
                                    const closingSibling = innerCurrentParentDoc[closingIndex - 1];
                                    if (debug) {
                                        console.info({closingIndex, closingSibling});
                                    }
                                    if (
                                        closingSibling &&
                                        typeof closingSibling === 'object' &&
                                        !Array.isArray(closingSibling) &&
                                        closingSibling.type === 'line' &&
                                        !closingSibling.soft
                                    ) {
                                        if (debug) {
                                            console.info(
                                                `found final line break inside of closing sibling`,
                                            );
                                        }
                                        finalLineBreakExists = true;
                                    }
                                }
                                return false;
                            } else if (currentDoc && nestingSyntaxClose.includes(currentDoc)) {
                                throw new Error(`Found closing syntax which shouldn't be walked`);
                            } else if (currentDoc === ',') {
                                if (debug) {
                                    console.info({foundCommaIn: innerCurrentParentDoc});
                                }
                                if (!Array.isArray(innerCurrentParentDoc)) {
                                    console.error({innerParentDoc: innerCurrentParentDoc});
                                    throw new Error(
                                        `Found comma but innerParentDoc is not an array.`,
                                    );
                                }
                                if (commaChildIndex == undefined) {
                                    throw new Error(`Found comma but childIndex is undefined.`);
                                }

                                let siblingIndex: number = commaChildIndex + 1;
                                let parentToMutate: Doc[] = innerCurrentParentDoc;
                                if (commaChildIndex === innerCurrentParentDoc.length - 1) {
                                    const commaGrandParent = commaParents[1];
                                    if (commaGrandParent == undefined) {
                                        throw new Error(
                                            `Could not find grandparent of comma group.`,
                                        );
                                    }
                                    if (commaGrandParent.childIndexInThisParent == undefined) {
                                        throw new Error(
                                            `Could not find index of comma group parent`,
                                        );
                                    }
                                    if (!Array.isArray(commaGrandParent.parent)) {
                                        throw new TypeError(
                                            `Comma group grandparent is not an array.`,
                                        );
                                    }
                                    siblingIndex = commaGrandParent.childIndexInThisParent + 1;
                                    parentToMutate = commaGrandParent.parent;
                                }

                                if (debug) {
                                    console.info({
                                        commaParentDoc: innerCurrentParentDoc,
                                        parentToMutate,
                                        siblingIndex,
                                    });
                                }

                                let maybeCommaSibling = parentToMutate[siblingIndex];

                                if (debug) {
                                    console.info(
                                        `Trying to find comma sibling at index ${siblingIndex}`,
                                        stringify({parentToMutate, maybeCommaSibling}),
                                    );
                                }

                                function isCommaSibling(
                                    maybe: doc.builders.Doc | undefined,
                                ): maybe is doc.builders.DocCommand | [doc.builders.DocCommand] {
                                    return (
                                        (isDocCommand(maybe) && maybe.type === 'line') ||
                                        (Array.isArray(maybe) &&
                                            isDocCommand(maybe[0]) &&
                                            maybe[0].type === 'line')
                                    );
                                }

                                while (
                                    !isCommaSibling(maybeCommaSibling) &&
                                    siblingIndex < parentToMutate.length
                                ) {
                                    siblingIndex++;
                                    maybeCommaSibling = parentToMutate[siblingIndex];
                                    if (debug) {
                                        console.info(
                                            `Trying to find comma sibling at index ${siblingIndex}`,
                                            parentToMutate,
                                            maybeCommaSibling,
                                        );
                                    }
                                }

                                if (debug) {
                                    console.info(
                                        `Found comma sibling at index ${siblingIndex}`,
                                        parentToMutate,
                                        maybeCommaSibling,
                                    );
                                }

                                if (!isCommaSibling(maybeCommaSibling)) {
                                    throw new Error(
                                        `Found comma but its following sibling is not a line: ${stringify(maybeCommaSibling)}`,
                                    );
                                }
                                const commaSibling = maybeCommaSibling;

                                const currentLineCountIndex = lineIndex % lineCounts.length;
                                const currentLineCount: number | undefined = lineCounts.length
                                    ? lineCounts[currentLineCountIndex]
                                    : undefined;
                                arrayChildCount++;
                                if (
                                    (currentLineCount && columnCount === currentLineCount) ||
                                    !currentLineCount
                                ) {
                                    // if we're on the last element of the line then increment to the next line
                                    lineIndex++;
                                    columnCount = 1;
                                    /**
                                     * Don't use doc.builders.hardline here. It causes "invalid size
                                     * error" which I don't understand and which has no other useful
                                     * information or stack trace.
                                     */
                                    if (debug) {
                                        console.info({
                                            breakingAfter: parentToMutate[siblingIndex - 1],
                                        });
                                    }
                                    parentToMutate[siblingIndex] =
                                        doc.builders.hardlineWithoutBreakParent;
                                } else {
                                    parentToMutate[siblingIndex] = ' ';
                                    columnCount++;
                                }
                                undoMutations.push(() => {
                                    parentToMutate[siblingIndex] = commaSibling;
                                });
                            }
                        } else if (Array.isArray(currentDoc)) {
                            const firstPart = currentDoc[0];
                            const secondPart = currentDoc[1];
                            if (debug) {
                                console.info('got concat child doc');
                                console.info(currentDoc, {firstPart, secondPart});
                                console.info(
                                    isDocCommand(firstPart),
                                    isDocCommand(secondPart),
                                    (firstPart as any)?.type === 'line',
                                    (firstPart as any)?.hard,
                                    (secondPart as any)?.type === 'break-parent',
                                );
                            }
                            if (
                                isDocCommand(firstPart) &&
                                isDocCommand(secondPart) &&
                                firstPart.type === 'line' &&
                                firstPart.hard &&
                                secondPart.type === 'break-parent'
                            ) {
                                if (debug) {
                                    console.info('concat child was indeed a line break');
                                }
                                forceFinalLineBreakExists = true;
                                return false;
                            } else if (debug) {
                                console.info('concat child doc was not a line break');
                            }
                        }
                        return true;
                    },
                );
            }

            if (forceFinalLineBreakExists) {
                finalLineBreakExists = true;
            }

            if (!finalLineBreakExists) {
                if (debug) {
                    console.info(
                        `Parsed all array children but finalBreakHappened = ${finalLineBreakExists}`,
                    );
                }

                const closingBracketIndex: number = parentDoc.indexOf(']');
                const preBracketChild = parentDoc[closingBracketIndex - 1];
                if (isDocCommand(preBracketChild) && preBracketChild.type === 'line') {
                    parentDoc.splice(closingBracketIndex - 1, 1);
                    undoMutations.push(() => {
                        parentDoc.splice(closingBracketIndex - 1, 0, preBracketChild);
                    });
                }

                parentDoc.splice(
                    closingBracketIndex - 1,
                    0,
                    doc.builders.hardlineWithoutBreakParent,
                );
                undoMutations.push(() => {
                    parentDoc.splice(closingBracketIndex - 1, 1);
                });
            }

            if (Array.isArray(indentedContent)) {
                const oldIndentContentChild = indentContents[1];
                indentContents.splice(
                    1,
                    1,
                    doc.builders.group([
                        doc.builders.hardlineWithoutBreakParent,
                        ...indentedContent,
                    ]),
                );
                undoMutations.push(() => {
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    indentContents[1] = oldIndentContentChild!;
                });
            } else {
                const oldParts = indentedContent.parts;
                indentedContent.parts = [
                    doc.builders.group([
                        doc.builders.hardlineWithoutBreakParent,
                        ...indentedContent.parts,
                    ]),
                ];
                undoMutations.push(() => {
                    indentedContent.parts = oldParts;
                });
            }

            if (arrayChildCount < wrapThreshold && !lineCounts.length && !manualWrap) {
                undoAllMutations();
            }

            // don't walk any deeper
            return false;
        } else if (debug) {
            console.info({ignoring: currentDoc});
        }

        return true;
    });

    if (debug) {
        console.info('final doc:', stringify(inputDoc));
    }

    // return what is input because we perform mutations on it
    return inputDoc;
}

function getLatestSetValue<T extends object>(
    currentLine: number,
    triggers: CommentTriggerWithEnding<T>,
): Values<T> | undefined {
    const relevantSetLineCountsKey: keyof T = getObjectTypedKeys(triggers)
        .sort()
        .reduce(
            (closestKey, currentKey): keyof T => {
                if (Number(currentKey) < currentLine) {
                    const currentData = triggers[currentKey] as
                        | CommentTriggerWithEnding<T>[keyof T]
                        | undefined;

                    if (currentData && currentData.lineEnd > currentLine) {
                        return currentKey;
                    }
                }

                return closestKey;
            },
            '' as keyof T,
        );
    const relevantSetLineCount = (triggers as AnyObject)[relevantSetLineCountsKey as any]?.data as
        | Values<T>
        | undefined;

    return relevantSetLineCount;
}

export function printWithMultilineArrays(
    originalFormattedOutput: Doc,
    path: AstPath,
    inputOptions: MultilineArrayOptions & ParserOptions,
    debug: boolean,
): Doc {
    const rootNode = path.stack[0];
    if (!rootNode) {
        throw new Error(
            `Could not find valid root node in ${path.stack.map((entry) => entry.type).join(',')}`,
        );
    }
    const node = path.getNode();

    if (node && isArrayLikeNode(node)) {
        if (!node.loc) {
            throw new Error(`Could not find location of node ${node.type}`);
        }
        const currentLineNumber = node.loc.start.line;
        const lastLine = currentLineNumber - 1;
        const commentTriggers = getCommentTriggers(rootNode, debug);

        const originalText: string = inputOptions.originalText;
        const splitOriginalText: string[] = originalText.split('\n');

        const includesLeadingNewline = containsLeadingNewline(
            node.loc,
            node.elements,
            splitOriginalText,
            debug,
        );
        const includesTrailingComma = containsTrailingComma(
            node.loc,
            node.elements,
            splitOriginalText,
            debug,
        );

        const relevantSetLineCount: number[] | undefined = getLatestSetValue(
            currentLineNumber,
            commentTriggers.setLineCounts,
        );

        const lineCounts: number[] =
            commentTriggers.nextLineCounts[lastLine] ??
            relevantSetLineCount ??
            parseNextLineCounts(inputOptions.multilineArraysLinePattern, false, debug);

        const relevantSetWrapCommentThreshold = getLatestSetValue(
            currentLineNumber,
            commentTriggers.setWrapThresholds,
        );

        const wrapThreshold: number =
            commentTriggers.nextWrapThresholds[lastLine] ??
            relevantSetWrapCommentThreshold ??
            (inputOptions.multilineArraysWrapThreshold < 0
                ? Infinity
                : inputOptions.multilineArraysWrapThreshold);

        const includesCommentTrigger: boolean =
            (commentTriggers.nextWrapThresholds[lastLine] ?? relevantSetWrapCommentThreshold) !=
                undefined || !!lineCounts.length;

        if (debug) {
            console.info(`======= Starting call to ${insertLinesIntoArray.name}: =======`);
            console.info({options: {lineCounts, wrapThreshold}});
        }

        const manualWrap = includesCommentTrigger
            ? false
            : includesTrailingComma || includesLeadingNewline;

        // console.log({
        //     wrapThreshold,
        //     includesCommentTrigger,
        //     manualWrap,
        //     includesTrailingComma,
        //     includesLeadingNewline,
        // });

        const newDoc = insertLinesIntoArray(
            originalFormattedOutput,
            manualWrap,
            lineCounts,
            wrapThreshold,
            debug,
        );
        return newDoc;
    }

    return originalFormattedOutput;
}
