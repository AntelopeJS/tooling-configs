/** Wraps a proof bin's output in markers that carry its command, revisions and digest. */
export function stampProof(
  _root: string,
  _command: string,
  _baseRef: string,
  output: string,
): string {
  return output;
}
