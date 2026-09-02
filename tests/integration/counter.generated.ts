// DO NOT EDIT, code generated with task `generate-contracts`
import type { Abi, Hex } from "viem";

const artifact = {
  "abi": [
    {
      "type": "function",
      "name": "add",
      "inputs": [
        {
          "name": "value",
          "type": "uint256",
          "internalType": "uint256",
        },
      ],
      "outputs": [],
      "stateMutability": "nonpayable",
    },
    {
      "type": "function",
      "name": "count",
      "inputs": [],
      "outputs": [
        {
          "name": "",
          "type": "uint256",
          "internalType": "uint256",
        },
      ],
      "stateMutability": "view",
    },
  ],
  "bytecode": {
    "object":
      "0x6080604052348015600f57600080fd5b506101818061001f6000396000f3fe608060405234801561001057600080fd5b50600436106100365760003560e01c806306661abd1461003b5780631003e2d214610056575b600080fd5b61004460005481565b60405190815260200160405180910390f35b6100696100643660046100f2565b61006b565b005b806000036100d9576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601660248201527f76616c7565206d757374206265206e6f6e2d7a65726f00000000000000000000604482015260640160405180910390fd5b806000808282546100ea919061010b565b909155505050565b60006020828403121561010457600080fd5b5035919050565b80820180821115610145577f4e487b7100000000000000000000000000000000000000000000000000000000600052601160045260246000fd5b9291505056fea264697066735822122044ae7047bf60406b28ed361cbfe6af3a5d8ae5e67d485c721d01a5a6fe78b3e164736f6c63430008240033",
    "sourceMap": "67:175:0:-:0;;;;;;;;;;;;;;;;;;;",
    "linkReferences": {},
  },
  "deployedBytecode": {
    "object":
      "0x608060405234801561001057600080fd5b50600436106100365760003560e01c806306661abd1461003b5780631003e2d214610056575b600080fd5b61004460005481565b60405190815260200160405180910390f35b6100696100643660046100f2565b61006b565b005b806000036100d9576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601660248201527f76616c7565206d757374206265206e6f6e2d7a65726f00000000000000000000604482015260640160405180910390fd5b806000808282546100ea919061010b565b909155505050565b60006020828403121561010457600080fd5b5035919050565b80820180821115610145577f4e487b7100000000000000000000000000000000000000000000000000000000600052601160045260246000fd5b9291505056fea264697066735822122044ae7047bf60406b28ed361cbfe6af3a5d8ae5e67d485c721d01a5a6fe78b3e164736f6c63430008240033",
    "sourceMap":
      "67:175:0:-:0;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;90:20;;;;;;;;;160:25:1;;;148:2;133:18;90:20:0;;;;;;;117:123;;;;;;:::i;:::-;;:::i;:::-;;;172:5;181:1;172:10;164:45;;;;;;;583:2:1;164:45:0;;;565:21:1;622:2;602:18;;;595:30;661:24;641:18;;;634:52;703:18;;164:45:0;;;;;;;;228:5;219;;:14;;;;;;;:::i;:::-;;;;-1:-1:-1;;;117:123:0:o;196:180:1:-;255:6;308:2;296:9;287:7;283:23;279:32;276:52;;;324:1;321;314:12;276:52;-1:-1:-1;347:23:1;;196:180;-1:-1:-1;196:180:1:o;732:279::-;797:9;;;818:10;;;815:190;;;861:77;858:1;851:88;962:4;959:1;952:15;990:4;987:1;980:15;815:190;732:279;;;;:::o",
    "linkReferences": {},
  },
  "methodIdentifiers": {
    "add(uint256)": "1003e2d2",
    "count()": "06661abd",
  },
  "rawMetadata":
    '{"compiler":{"version":"0.8.36+commit.8a079791"},"language":"Solidity","output":{"abi":[{"inputs":[{"internalType":"uint256","name":"value","type":"uint256"}],"name":"add","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"count","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}],"devdoc":{"kind":"dev","methods":{},"version":1},"userdoc":{"kind":"user","methods":{},"version":1}},"settings":{"compilationTarget":{"test/Counter.sol":"Counter"},"evmVersion":"constantinople","libraries":{},"metadata":{"bytecodeHash":"ipfs"},"optimizer":{"enabled":true,"runs":1000000},"remappings":[":forge-std/=lib/forge-std/src/"]},"sources":{"test/Counter.sol":{"keccak256":"0xbb75772b9c45eedd85c8b430dbd08b9c79ce681662658e509adb79fe651f5507","license":"GPL-3.0-only","urls":["bzz-raw://bd2a33dea29653f2aa132bb622873e5814dfe2aa7972ec52a8a0ebde6cab90ae","dweb:/ipfs/QmTH3NUTo4j5LQaWcyHo4QRNuHghNQgdUPnEPC9FbSEEhd"]}},"version":1}',
  "metadata": {
    "compiler": {
      "version": "0.8.36+commit.8a079791",
    },
    "language": "Solidity",
    "output": {
      "abi": [
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "value",
              "type": "uint256",
            },
          ],
          "stateMutability": "nonpayable",
          "type": "function",
          "name": "add",
        },
        {
          "inputs": [],
          "stateMutability": "view",
          "type": "function",
          "name": "count",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256",
            },
          ],
        },
      ],
      "devdoc": {
        "kind": "dev",
        "methods": {},
        "version": 1,
      },
      "userdoc": {
        "kind": "user",
        "methods": {},
        "version": 1,
      },
    },
    "settings": {
      "remappings": [
        "forge-std/=lib/forge-std/src/",
      ],
      "optimizer": {
        "enabled": true,
        "runs": 1000000,
      },
      "metadata": {
        "bytecodeHash": "ipfs",
      },
      "compilationTarget": {
        "test/Counter.sol": "Counter",
      },
      "evmVersion": "constantinople",
      "libraries": {},
    },
    "sources": {
      "test/Counter.sol": {
        "keccak256": "0xbb75772b9c45eedd85c8b430dbd08b9c79ce681662658e509adb79fe651f5507",
        "urls": [
          "bzz-raw://bd2a33dea29653f2aa132bb622873e5814dfe2aa7972ec52a8a0ebde6cab90ae",
          "dweb:/ipfs/QmTH3NUTo4j5LQaWcyHo4QRNuHghNQgdUPnEPC9FbSEEhd",
        ],
        "license": "GPL-3.0-only",
      },
    },
    "version": 1,
  },
  "id": 0,
} as const;
export const abi = artifact.abi satisfies Abi;
export const bytecode = artifact.bytecode.object satisfies Hex;
