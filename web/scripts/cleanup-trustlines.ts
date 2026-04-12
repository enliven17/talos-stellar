/**
 * Removes stale trustlines from the operator account:
 *   - Old USDC (GCKIUOT... issuer) — sends balance back to issuer, then removes
 *   - NOE token from same issuer — removes (balance already 0)
 */
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

const secret = process.env.STELLAR_OPERATOR_SECRET_KEY!;
const keypair = Keypair.fromSecret(secret);
const server = new Horizon.Server("https://horizon-testnet.stellar.org");

const OLD_ISSUER = "GCKIUOTK3NWD33ONH7TQERCSLECXLWQMA377HSJR4E2MV7KPQFAQLOLN";

async function main() {
  const account = await server.loadAccount(keypair.publicKey());
  const balances = account.balances as any[];

  const oldUsdc = balances.find(b => b.asset_code === "USDC" && b.asset_issuer === OLD_ISSUER);
  const noe    = balances.find(b => b.asset_code === "NOE"  && b.asset_issuer === OLD_ISSUER);

  const ops: any[] = [];

  // Send old USDC balance back to issuer (burn) if non-zero
  if (oldUsdc && parseFloat(oldUsdc.balance) > 0) {
    console.log(`Sending ${oldUsdc.balance} old USDC back to issuer...`);
    ops.push(Operation.payment({
      destination: OLD_ISSUER,
      asset: new Asset("USDC", OLD_ISSUER),
      amount: oldUsdc.balance,
    }));
  }

  // Remove old USDC trustline
  if (oldUsdc) {
    console.log("Removing old USDC trustline...");
    ops.push(Operation.changeTrust({ asset: new Asset("USDC", OLD_ISSUER), limit: "0" }));
  }

  // Remove NOE trustline
  if (noe) {
    console.log("Removing NOE trustline...");
    ops.push(Operation.changeTrust({ asset: new Asset("NOE", OLD_ISSUER), limit: "0" }));
  }

  if (ops.length === 0) {
    console.log("Nothing to clean up.");
    return;
  }

  const fresh = await server.loadAccount(keypair.publicKey());
  const tx = new TransactionBuilder(fresh, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  });
  for (const op of ops) tx.addOperation(op);
  const built = tx.setTimeout(30).build();
  built.sign(keypair);

  const res = await server.submitTransaction(built);
  console.log("✅ Done:", res.hash);
}

main().catch(console.error);
