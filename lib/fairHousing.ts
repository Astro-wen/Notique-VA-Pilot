/**
 * Words that usually describe a protected characteristic (familial status, age, religion, disability,
 * military status, national origin and so on). Fair housing rules mean these never reach the agent's
 * deal profile: the VA rewrites the fact as a property requirement or declines it.
 * Shared by the Verify screen and the server, so the rule cannot be skipped from either side.
 */
export const PROTECTED =
  /\b(wife|husband|spouse|married|single (mom|mother|dad|father|parent)|(father|mother|parents?) of (one|two|three|four|five|six|\d+)|divorc\w*|pregnan\w*|kids?|child(ren)?|son|daughter|baby|famil(y|ies)|veteran|military|disab\w*|wheelchair|religio\w*|church|mosque|temple|synagogue|christian|muslim|jewish|hindu|race|ethnic\w*|nationality|immigra\w*|elderly|retire[de]?|\d+ years old|years of age|gay|lesbian|transgender)\b/i;

/** Property words that contain a flagged word but describe the building, not a person. */
const PROPERTY_TERMS = /\b(single|multi|two|three|four)[- ]famil(y|ies)\b|\bfamily room\b|\bsenior (living|community|housing)\b|\bchild[- ]?proof\b/gi;

/** The first word that looks like a protected characteristic, ignoring property terms. */
export function flaggedWord(text: string): string | null {
  const m = text.replace(PROPERTY_TERMS, " ").match(PROTECTED);
  return m ? m[0] : null;
}

/** The refusal shown to the VA, naming the word that triggered it. */
export function fairHousingMessage(text: string): string {
  const w = flaggedWord(text);
  return w ? `"${w}" usually describes a person rather than the property (family, age, religion, disability, military service and similar). Rewrite it as a property requirement, for example "needs four bedrooms", or decline it.` : FAIR_HOUSING_HELP;
}

export const FAIR_HOUSING_HELP = "This wording describes a person rather than the property (family, age, religion, disability, military service and similar). Rewrite it as a property requirement, for example \"needs four bedrooms\", or decline it.";
