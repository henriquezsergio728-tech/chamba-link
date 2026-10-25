import { expect, test } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth/password.js";

const PHC = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/;

test("a hash is an argon2id PHC string with the configured parameters", async () => {
  expect(await hashPassword("correct horse battery")).toMatch(PHC);
});

test("verify accepts the password and rejects any other", async () => {
  const stored = await hashPassword("correct horse battery");
  expect(await verifyPassword("correct horse battery", stored)).toBe(true);
  expect(await verifyPassword("correct horse batterY", stored)).toBe(false);
  expect(await verifyPassword("", stored)).toBe(false);
});

test("verify reads the parameters from the stored string", async () => {
  const stored = await hashPassword("correct horse battery");
  // Same salt and tag under different parameters must not verify.
  expect(await verifyPassword("correct horse battery", stored.replace("t=2", "t=3"))).toBe(false);
});

test.each([
  ["empty", ""],
  ["plain text", "not a hash"],
  ["another algorithm", "$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g"],
  ["a missing hash", "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$"],
  ["invalid base64", "$argon2id$v=19$m=19456,t=2,p=1$!!!$???"],
  ["parameters argon2 rejects", "$argon2id$v=19$m=1,t=0,p=0$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g"],
  ["a salt argon2 rejects", "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g"],
])("a malformed stored hash (%s) returns false without throwing", async (_, stored) => {
  await expect(verifyPassword("correct horse battery", stored)).resolves.toBe(false);
});

test("two hashes of the same password differ", async () => {
  expect(await hashPassword("correct horse battery")).not.toBe(await hashPassword("correct horse battery"));
});
