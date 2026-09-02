import { foundry } from "viem/chains";
import { etchSingletonFactory, startApp, stopApp, walletPrivateKey } from "./app.ts";

Deno.test("smoke: app starts up and its worker connects to the chain", async () => {
  await etchSingletonFactory();
  const app = await startApp({
    wallets: [{ privateKey: walletPrivateKey, chains: [{ chainId: foundry.id }] }],
  });
  await stopApp(app);
});
