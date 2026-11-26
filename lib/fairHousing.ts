/**
 * Words that usually describe a protected characteristic (familial status, age, religion, disability,
 * military status, national origin and so on). Fair housing rules mean these never reach the agent's
 * deal profile: the VA rewrites the fact as a property requirement or declines it.
 * Shared by the Verify screen and the server, so the rule cannot be skipped from either side.
 */
export const PROTECTED =
  /\b(wife|husband|spouse|married|single (mom|mother|dad|father|parent)|(father|mother|parents?) of (one|two|three|four|five|six|\d+)|divorc\w*|pregnan\w*|kids?|child(ren)?|son|daughter|baby|famil(y|ies)|veteran|military|disab\w*|wheelchair|religio\w*|church|mosque|temple|synagogue|christian|muslim|jewish|hindu|race|ethnic\w*|nationality|immigra\w*|elderly|retire[de]?|\d+ years old|years of age|gay|lesbian|transgender)\b/i;

export const FAIR_HOUSING_HELP = "This wording describes a person rather than the property (family, age, religion, disability, military service and similar). Rewrite it as a property requirement, for example \"needs four bedrooms\", or decline it.";
