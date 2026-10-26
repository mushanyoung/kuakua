import { isValueId, LIMITS } from "../shared/values.ts";
import { HttpError } from "./errors.ts";

export type NewPost = {
  kind: string;
  recipientIds: unknown;
  ccIds?: unknown;
  message: unknown;
  valueTag?: unknown;
  private?: unknown;
};

export function preparePost(input: NewPost, senderId: number, bonusPoints: number) {
  const kind = input.kind === "bonus" ? "bonus" : input.kind === "kudos" ? "kudos" : null;
  if (!kind) throw new HttpError(400, "bad_kind");
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!message) throw new HttpError(400, "message_required");
  if (message.length > LIMITS.messageMax) throw new HttpError(400, "message_too_long");
  if (kind === "bonus" && message.length < LIMITS.messageMinBonus) throw new HttpError(400, "message_too_short");
  const valueTag = typeof input.valueTag === "string" && isValueId(input.valueTag) ? input.valueTag : null;

  const ids = Array.isArray(input.recipientIds) ? [...new Set(input.recipientIds.map(Number))] : [];
  if (!ids.length || ids.some((n) => !Number.isInteger(n))) throw new HttpError(400, "recipients_required");
  if (ids.length > LIMITS.recipientsMax) throw new HttpError(400, "too_many_recipients");
  // Kudos to yourself is fine; points to yourself are not.
  if (kind === "bonus" && ids.includes(senderId)) throw new HttpError(400, "no_self_bonus");

  // CC'd people are only notified; anyone already a recipient is dropped. The sender may CC themselves.
  const ccIds = Array.isArray(input.ccIds) ? [...new Set(input.ccIds.map(Number))].filter((n) => !ids.includes(n)) : [];
  if (ccIds.some((n) => !Number.isInteger(n))) throw new HttpError(400, "cc_not_found");
  if (ccIds.length > LIMITS.ccMax) throw new HttpError(400, "too_many_cc");

  const points = kind === "bonus" ? bonusPoints : 0;
  return { kind, message, valueTag, ids, ccIds, points, cost: points * ids.length };
}
