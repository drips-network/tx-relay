import { Application, Router } from "oak";
import { z } from "zod";
import { Hex, isHex } from "viem";

import { getMulticall3s, getPort } from "./config.ts";

const multicall3s = getMulticall3s();

const sendSchema = z.object({
  calls: z.array(z.object({
    target: z.string().refine(isHex),
    calldata: z.string().refine(isHex),
  })).nonempty(),
});

const router = new Router();
router
  .post("/:chainId/send", async (context) => {
    const multicall3 = multicall3s[Number(context.params.chainId)];
    if (!multicall3) {
      context.response.status = 404;
      context.response.body = "Unsupported chain ID";
      return;
    }

    let sendArg: z.infer<typeof sendSchema>;
    try {
      sendArg = sendSchema.parse(await context.request.body.json());
    } catch (error) {
      context.response.status = 400;
      context.response.body = String(error);
      return;
    }

    const calls = sendArg.calls.map(({ target, calldata }) => ({
      target: target as Hex,
      callData: calldata as Hex,
      allowFailure: false,
    }));

    let txHash: Hex;
    try {
      txHash = await multicall3.write.aggregate3([calls]);
    } catch (error) {
      context.response.status = 500;
      context.response.body = String(error);
      return;
    }

    context.response.body = { txHash };
  });

await new Application()
  .use(router.routes())
  .use(router.allowedMethods())
  .listen({ port: getPort(), hostname: "[::]" });
