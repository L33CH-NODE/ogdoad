// Stand-ins: what the team sees in place of a real identity. A stand-in is a family word and four
// digits (C-4821 for a client, EMAIL-2210 for an email address), short enough that a model copies it
// exactly and plain enough that it reads as what it is. No Node imports: the UI bundles this too.

export type Kind = "who" | "me" | "email" | "phone" | "address" | "abn" | "ndis" | "bank" | "tfn" | "medicare" | "card" | "dob";

/** Each kind's family word. "who" is C, as the calendar already shows clients. */
export const FAMILY: Record<Kind, string> = {
  who: "C", me: "ME", email: "EMAIL", phone: "PHONE", address: "ADDR", abn: "ABN", ndis: "NDIS", bank: "BANK", tfn: "TFN", medicare: "MEDICARE", card: "CARD", dob: "DOB",
};

/** What each kind is, in words, for the check card. */
export const KIND_WORD: Record<Kind, string> = {
  who: "a client or participant", me: "your business", email: "an email address", phone: "a phone number", address: "an address", abn: "an ABN",
  ndis: "an NDIS number", bank: "bank details", tfn: "a tax file number", medicare: "a Medicare number", card: "a card number", dob: "a date of birth",
};

const FAMILIES = Object.values(FAMILY).sort((a, b) => b.length - a.length).join("|");

/** A stand-in, exactly as Ogdoad writes it. */
export const TOKEN_SOURCE = `\\b(?:${FAMILIES})-[1-9]\\d{3}\\b`;
export const tokenRe = (flags = "g") => new RegExp(TOKEN_SOURCE, flags);
