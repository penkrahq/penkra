import { UserItemData } from "@penkra/contracts";
import { Schema } from "effect";

/** All canonical user-item consumers share this strict decoder. */
export const decodeUserItemData = Schema.decodeUnknownSync(UserItemData);
