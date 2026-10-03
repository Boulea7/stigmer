/**
 * What both store drivers share about resource names (interface.ts,
 * `ResourceNameStore`): the rules a driver checks before it writes, kept in
 * one place so the two engines cannot disagree. The drivers own the SQL.
 */
import type { ResourceNameRename } from "./interface.js";

/**
 * Refuses a rename onto its own name, which would leave the resource with
 * no current name: the write makes `to` current and then `from` previous,
 * and they would be the same row.
 */
export function assertRenameMoves(rename: ResourceNameRename): void {
  if (rename.from === rename.to) {
    throw new Error(
      `resource name rename of '${rename.id}' names '${rename.from}' as both its old and new name`,
    );
  }
}
