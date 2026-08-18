/**
 * Runtime mirror of the Status enum from the built-in git extension.
 * The values in git.d.ts are declarations only and vanish at compile time.
 */
export enum Status {
  INDEX_MODIFIED = 0,
  INDEX_ADDED = 1,
  INDEX_DELETED = 2,
  INDEX_RENAMED = 3,
  INDEX_COPIED = 4,
  MODIFIED = 5,
  DELETED = 6,
  UNTRACKED = 7,
  IGNORED = 8,
  INTENT_TO_ADD = 9,
  ADDED_BY_US = 10,
  ADDED_BY_THEM = 11,
  DELETED_BY_US = 12,
  DELETED_BY_THEM = 13,
  BOTH_ADDED = 14,
  BOTH_DELETED = 15,
  BOTH_MODIFIED = 16
}
