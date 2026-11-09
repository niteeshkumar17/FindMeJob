import { clearSettleError, recordLastMailError, recordSettleError, settleHeldDrafts } from "./deliver.js";
import { scanInbox } from "./inbox.js";
import { assertMailReady, isMailAuthError } from "./mail.js";
import type { StateFiles } from "./state.js";

export async function runHuntPass(args: {
  files: StateFiles;
  now?: Date;
  probeAuth?: () => Promise<void>;
  scanInbox?: (files: StateFiles) => Promise<unknown>;
  settleHeldDrafts?: (files: StateFiles) => Promise<void>;
  clearSettleError?: (files: StateFiles) => Promise<void>;
  recordSettleError?: (files: StateFiles, error: unknown) => Promise<void>;
  startModel?: () => void;
}): Promise<void> {
  const now = args.now ?? new Date();
  const probeAuth = args.probeAuth ?? assertMailReady;
  const scan = args.scanInbox ?? scanInbox;
  const settle = args.settleHeldDrafts ?? settleHeldDrafts;
  const clear = args.clearSettleError ?? clearSettleError;
  const recordSettle = args.recordSettleError ?? recordSettleError;
  try {
    await probeAuth();
  } catch (error) {
    if (isMailAuthError(error)) {
      await recordLastMailError(args.files, error, now);
    }
    throw error;
  }
  try {
    await scan(args.files);
  } catch (error) {
    if (isMailAuthError(error)) {
      await recordLastMailError(args.files, error, now);
      throw error;
    }
  }
  try {
    await settle(args.files);
    await clear(args.files);
  } catch (error) {
    if (isMailAuthError(error)) {
      await recordLastMailError(args.files, error, now);
      throw error;
    }
    await recordSettle(args.files, error);
  }
  args.startModel?.();
}
