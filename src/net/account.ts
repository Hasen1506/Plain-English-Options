// Recognise the states a brand-new wallet is in before its first deposit.

/** public/login on a wallet that never deposited answers "Account not found". */
export function isNoAccount(e: unknown): boolean {
  const m = (e as { message?: string })?.message ?? "";
  return /account not found|account does not exist/i.test(m);
}
