/**
 * Password policy — common-password denylist.
 *
 * NIST SP 800-63B requires rejecting passwords found in lists of commonly
 * used or expected values: they are the first guesses in every online
 * credential attack, and throttles only slow that guessing down. The list is
 * deliberately small (the worst offenders, case-insensitive) so legitimate
 * passphrases are never collateral. Length and composition rules stay with
 * the per-project configuration; this floor applies everywhere.
 */

const COMMON_PASSWORDS: ReadonlySet<string> = new Set(
  [
    // Numeric sequences and repeats
    "123456", "1234567", "12345678", "123456789", "1234567890", "12345678910",
    "0123456789", "12345", "1234", "111111", "11111111", "1111111111", "000000",
    "00000000", "222222", "333333", "444444", "555555", "666666", "7777777",
    "888888", "88888888", "999999", "123123", "112233", "11223344", "102030",
    "123321", "12344321", "123654", "12369874", "121212", "131313", "100200",
    "13579", "24680", "147258", "147852", "159357", "159753", "258963", "321654",
    "654321", "741852", "852456", "87654321", "963852", "987654321", "1029384756",
    "5201314", "201314", "134679",
    // Keyboard walks
    "qwerty", "qwerty1", "qwerty12", "qwerty123", "qwertyuiop", "qazwsx", "qazxsw",
    "qwe123", "1qaz2wsx", "1qazxsw2", "12qwaszx", "zaq1zaq1", "zxcvbn", "zxcvbnm",
    "asdfgh", "asdasd", "poiuyt", "mnbvcx", "1q2w3e", "1q2w3e4r", "q1w2e3r4",
    // Words and names
    "password", "password1", "passw0rd", "pass123", "letmein", "welcome", "welcome1",
    "admin", "admin123", "administrator", "root", "master", "login", "user",
    "iloveyou", "loveme", "princess", "dragon", "monkey", "shadow", "superman",
    "batman", "football", "baseball", "soccer", "hockey", "killer", "hunter",
    "buster", "charlie", "thomas", "robert", "daniel", "andrew", "jordan",
    "michael", "jennifer", "michelle", "jessica", "harley", "ranger", "george",
    "ginger", "pepper", "flower", "hottie", "starwars", "freedom", "whatever",
    "trustno1", "google", "chelsea", "banana", "sunshine", "tigger", "computer",
    "michelle1", "hello", "hello123", "abc123", "123abc", "a123456", "123qwe",
    "1a2b3c", "aa123456", "secret", "secret1", "changeme", "test123", "demo",
    "p@ssw0rd", "p@ssword", "passw0rd1",
  ].map((p) => p.toLowerCase())
);

/**
 * True when the password is a well-known guess. Comparison is
 * case-insensitive; the surrounding trim/normalization is left to the caller
 * (length checks run before this in every flow).
 */
export function isCommonPassword(password: string): boolean {
  if (typeof password !== "string") return false;
  return COMMON_PASSWORDS.has(password.toLowerCase());
}

/** Shared rejection message so every tier reports the policy the same way. */
export const COMMON_PASSWORD_MESSAGE =
  "This password is too common and easy to guess. Choose a stronger, unique password.";
