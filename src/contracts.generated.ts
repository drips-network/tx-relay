// DO NOT EDIT, code generated with task `generate-contracts`
import type { Abi, Hex } from "viem";

const executorArtifact = {
  "abi": [
    {
      "type": "function",
      "name": "exec",
      "inputs": [
        {
          "name": "bursts",
          "type": "tuple[]",
          "internalType": "struct Burst[]",
          "components": [
            {
              "name": "needsPrev",
              "type": "bool",
              "internalType": "bool",
            },
            {
              "name": "gas",
              "type": "uint256",
              "internalType": "uint256",
            },
            {
              "name": "calls",
              "type": "tuple[]",
              "internalType": "struct Call[]",
              "components": [
                {
                  "name": "target",
                  "type": "address",
                  "internalType": "address",
                },
                {
                  "name": "data",
                  "type": "bytes",
                  "internalType": "bytes",
                },
                {
                  "name": "gas",
                  "type": "uint256",
                  "internalType": "uint256",
                },
              ],
            },
          ],
        },
      ],
      "outputs": [
        {
          "name": "gasReport",
          "type": "int256[]",
          "internalType": "int256[]",
        },
      ],
      "stateMutability": "nonpayable",
    },
    {
      "type": "function",
      "name": "execNext",
      "inputs": [
        {
          "name": "bursts",
          "type": "tuple[]",
          "internalType": "struct Burst[]",
          "components": [
            {
              "name": "needsPrev",
              "type": "bool",
              "internalType": "bool",
            },
            {
              "name": "gas",
              "type": "uint256",
              "internalType": "uint256",
            },
            {
              "name": "calls",
              "type": "tuple[]",
              "internalType": "struct Call[]",
              "components": [
                {
                  "name": "target",
                  "type": "address",
                  "internalType": "address",
                },
                {
                  "name": "data",
                  "type": "bytes",
                  "internalType": "bytes",
                },
                {
                  "name": "gas",
                  "type": "uint256",
                  "internalType": "uint256",
                },
              ],
            },
          ],
        },
        {
          "name": "burstsGas",
          "type": "uint256",
          "internalType": "uint256",
        },
        {
          "name": "nextBurstCalls",
          "type": "tuple[]",
          "internalType": "struct Call[]",
          "components": [
            {
              "name": "target",
              "type": "address",
              "internalType": "address",
            },
            {
              "name": "data",
              "type": "bytes",
              "internalType": "bytes",
            },
            {
              "name": "gas",
              "type": "uint256",
              "internalType": "uint256",
            },
          ],
        },
      ],
      "outputs": [
        {
          "name": "nextBurstGas",
          "type": "uint256",
          "internalType": "uint256",
        },
      ],
      "stateMutability": "nonpayable",
    },
    {
      "type": "function",
      "name": "execSingle",
      "inputs": [
        {
          "name": "calls",
          "type": "tuple[]",
          "internalType": "struct Call[]",
          "components": [
            {
              "name": "target",
              "type": "address",
              "internalType": "address",
            },
            {
              "name": "data",
              "type": "bytes",
              "internalType": "bytes",
            },
            {
              "name": "gas",
              "type": "uint256",
              "internalType": "uint256",
            },
          ],
        },
      ],
      "outputs": [],
      "stateMutability": "nonpayable",
    },
    {
      "type": "event",
      "name": "Receipt",
      "inputs": [
        {
          "name": "gasReport",
          "type": "int256[]",
          "indexed": false,
          "internalType": "int256[]",
        },
      ],
      "anonymous": false,
    },
  ],
  "bytecode": {
    "object":
      "0x6080604052348015600f57600080fd5b50610b368061001f6000396000f3fe608060405234801561001057600080fd5b50600436106100415760003560e01c80635835cb8014610046578063b8ce26f91461005b578063f6cc90ce14610081575b600080fd5b610059610054366004610544565b6100a1565b005b61006e610069366004610586565b6101b0565b6040519081526020015b60405180910390f35b61009461008f366004610544565b6102a8565b6040516100789190610605565b7fffffffffffffffffffffffffba879a9c8a8b908ddfd2df9b8d9e9691df989e8d32016100ca57fe5b60005b818110156101ab57368383838181106100e8576100e8610648565b90506020028101906100fa9190610677565b90506040810135600081900361010e575a90505b600061011d60208401846106de565b73ffffffffffffffffffffffffffffffffffffffff16826101416020860186610700565b60405161014f929190610765565b60006040518083038160008787f1925050503d806000811461018d576040519150601f19603f3d011682016040523d82523d6000602084013e610192565b606091505b50509050806101a057600080fd5b5050506001016100cd565b505050565b600080845a6101bf91906107a4565b905060006101cd88886102a8565b90505b815a116101d05760005b81518110156102115760008282815181106101f7576101f7610648565b60200260200101511361020957600080fd5b6001016101da565b5060405a61022090603f6107bd565b61022a91906107d4565b6040517f5835cb800000000000000000000000000000000000000000000000000000000081529093503090635835cb809061026b908890889060040161080f565b600060405180830381600087803b15801561028557600080fd5b505af1158015610299573d6000803e3d6000fd5b50505050505095945050505050565b60606102b5826001610995565b67ffffffffffffffff8111156102cd576102cd6109a8565b6040519080825280602002602001820160405280156102f6578160200160208202803683370190505b509050600160005b81610312575a61030d906109d7565b610314565b5a5b83828151811061032657610326610648565b60209081029190910101528084146104b9573685858381811061034b5761034b610648565b905060200281019061035d9190610677565b90508215801561037557506103756020820182610a0f565b1561038057506104a7565b30602082013581635835cb806103996040860186610a31565b6040516024016103aa92919061080f565b604080517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08184030181529181526020820180517bffffffffffffffffffffffffffffffffffffffffffffffffffffffff1660e09490941b9390931790925290516104159250610a99565b60006040518083038160008787f1925050503d8060008114610453576040519150601f19603f3d011682016040523d82523d6000602084013e610458565b606091505b50909350507fffffffffffffffffffffffffba879a9c8a8b908ddfd2df9b8d9e9691df989e8d32016104a55780602001355a61049590603f6107bd565b10156104a057600080fd5b600192505b505b806104b181610ac8565b9150506102fe565b507f2f11af55833ef785aecc862ba1c283298eea75cf957861fcf5c922ece0b27315826040516104e99190610605565b60405180910390a15092915050565b60008083601f84011261050a57600080fd5b50813567ffffffffffffffff81111561052257600080fd5b6020830191508360208260051b850101111561053d57600080fd5b9250929050565b6000806020838503121561055757600080fd5b823567ffffffffffffffff81111561056e57600080fd5b61057a858286016104f8565b90969095509350505050565b60008060008060006060868803121561059e57600080fd5b853567ffffffffffffffff8111156105b557600080fd5b6105c1888289016104f8565b90965094505060208601359250604086013567ffffffffffffffff8111156105e857600080fd5b6105f4888289016104f8565b969995985093965092949392505050565b602080825282518282018190526000918401906040840190835b8181101561063d57835183526020938401939092019160010161061f565b509095945050505050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052603260045260246000fd5b600082357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa18336030181126106ab57600080fd5b9190910192915050565b803573ffffffffffffffffffffffffffffffffffffffff811681146106d957600080fd5b919050565b6000602082840312156106f057600080fd5b6106f9826106b5565b9392505050565b60008083357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe184360301811261073557600080fd5b83018035915067ffffffffffffffff82111561075057600080fd5b60200191503681900382131561053d57600080fd5b8183823760009101908152919050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052601160045260246000fd5b818103818111156107b7576107b7610775565b92915050565b80820281158282048414176107b7576107b7610775565b60008261080a577f4e487b7100000000000000000000000000000000000000000000000000000000600052601260045260246000fd5b500490565b6020808252810182905260006040600584901b8301810190830185837fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa136839003015b87821015610988577fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc0878603018452823581811261088f57600080fd5b890173ffffffffffffffffffffffffffffffffffffffff6108af826106b5565b16865260208101357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe18236030181126108e757600080fd5b810160208101903567ffffffffffffffff81111561090457600080fd5b80360382131561091357600080fd5b60606020890152806060890152808260808a013760006080828a010152600091506040830135915081604089015260807fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0601f8301168901019750505050602083019250602084019350600182019150610852565b5092979650505050505050565b808201808211156107b7576107b7610775565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052604160045260246000fd5b60007f80000000000000000000000000000000000000000000000000000000000000008203610a0857610a08610775565b5060000390565b600060208284031215610a2157600080fd5b813580151581146106f957600080fd5b60008083357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe1843603018112610a6657600080fd5b83018035915067ffffffffffffffff821115610a8157600080fd5b6020019150600581901b360382131561053d57600080fd5b6000825160005b81811015610aba5760208186018101518583015201610aa0565b506000920191825250919050565b60007fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8203610af957610af9610775565b506001019056fea2646970667358221220b3cbe1e73e67aff5a1b794c7288df89f93702087b540fb7380ff6d9da0b1f59f64736f6c63430008240033",
    "sourceMap": "246:2534:0:-:0;;;;;;;;;;;;;;;;;;;",
    "linkReferences": {},
  },
  "deployedBytecode": {
    "object":
      "0x608060405234801561001057600080fd5b50600436106100415760003560e01c80635835cb8014610046578063b8ce26f91461005b578063f6cc90ce14610081575b600080fd5b610059610054366004610544565b6100a1565b005b61006e610069366004610586565b6101b0565b6040519081526020015b60405180910390f35b61009461008f366004610544565b6102a8565b6040516100789190610605565b7fffffffffffffffffffffffffba879a9c8a8b908ddfd2df9b8d9e9691df989e8d32016100ca57fe5b60005b818110156101ab57368383838181106100e8576100e8610648565b90506020028101906100fa9190610677565b90506040810135600081900361010e575a90505b600061011d60208401846106de565b73ffffffffffffffffffffffffffffffffffffffff16826101416020860186610700565b60405161014f929190610765565b60006040518083038160008787f1925050503d806000811461018d576040519150601f19603f3d011682016040523d82523d6000602084013e610192565b606091505b50509050806101a057600080fd5b5050506001016100cd565b505050565b600080845a6101bf91906107a4565b905060006101cd88886102a8565b90505b815a116101d05760005b81518110156102115760008282815181106101f7576101f7610648565b60200260200101511361020957600080fd5b6001016101da565b5060405a61022090603f6107bd565b61022a91906107d4565b6040517f5835cb800000000000000000000000000000000000000000000000000000000081529093503090635835cb809061026b908890889060040161080f565b600060405180830381600087803b15801561028557600080fd5b505af1158015610299573d6000803e3d6000fd5b50505050505095945050505050565b60606102b5826001610995565b67ffffffffffffffff8111156102cd576102cd6109a8565b6040519080825280602002602001820160405280156102f6578160200160208202803683370190505b509050600160005b81610312575a61030d906109d7565b610314565b5a5b83828151811061032657610326610648565b60209081029190910101528084146104b9573685858381811061034b5761034b610648565b905060200281019061035d9190610677565b90508215801561037557506103756020820182610a0f565b1561038057506104a7565b30602082013581635835cb806103996040860186610a31565b6040516024016103aa92919061080f565b604080517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08184030181529181526020820180517bffffffffffffffffffffffffffffffffffffffffffffffffffffffff1660e09490941b9390931790925290516104159250610a99565b60006040518083038160008787f1925050503d8060008114610453576040519150601f19603f3d011682016040523d82523d6000602084013e610458565b606091505b50909350507fffffffffffffffffffffffffba879a9c8a8b908ddfd2df9b8d9e9691df989e8d32016104a55780602001355a61049590603f6107bd565b10156104a057600080fd5b600192505b505b806104b181610ac8565b9150506102fe565b507f2f11af55833ef785aecc862ba1c283298eea75cf957861fcf5c922ece0b27315826040516104e99190610605565b60405180910390a15092915050565b60008083601f84011261050a57600080fd5b50813567ffffffffffffffff81111561052257600080fd5b6020830191508360208260051b850101111561053d57600080fd5b9250929050565b6000806020838503121561055757600080fd5b823567ffffffffffffffff81111561056e57600080fd5b61057a858286016104f8565b90969095509350505050565b60008060008060006060868803121561059e57600080fd5b853567ffffffffffffffff8111156105b557600080fd5b6105c1888289016104f8565b90965094505060208601359250604086013567ffffffffffffffff8111156105e857600080fd5b6105f4888289016104f8565b969995985093965092949392505050565b602080825282518282018190526000918401906040840190835b8181101561063d57835183526020938401939092019160010161061f565b509095945050505050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052603260045260246000fd5b600082357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa18336030181126106ab57600080fd5b9190910192915050565b803573ffffffffffffffffffffffffffffffffffffffff811681146106d957600080fd5b919050565b6000602082840312156106f057600080fd5b6106f9826106b5565b9392505050565b60008083357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe184360301811261073557600080fd5b83018035915067ffffffffffffffff82111561075057600080fd5b60200191503681900382131561053d57600080fd5b8183823760009101908152919050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052601160045260246000fd5b818103818111156107b7576107b7610775565b92915050565b80820281158282048414176107b7576107b7610775565b60008261080a577f4e487b7100000000000000000000000000000000000000000000000000000000600052601260045260246000fd5b500490565b6020808252810182905260006040600584901b8301810190830185837fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa136839003015b87821015610988577fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc0878603018452823581811261088f57600080fd5b890173ffffffffffffffffffffffffffffffffffffffff6108af826106b5565b16865260208101357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe18236030181126108e757600080fd5b810160208101903567ffffffffffffffff81111561090457600080fd5b80360382131561091357600080fd5b60606020890152806060890152808260808a013760006080828a010152600091506040830135915081604089015260807fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0601f8301168901019750505050602083019250602084019350600182019150610852565b5092979650505050505050565b808201808211156107b7576107b7610775565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052604160045260246000fd5b60007f80000000000000000000000000000000000000000000000000000000000000008203610a0857610a08610775565b5060000390565b600060208284031215610a2157600080fd5b813580151581146106f957600080fd5b60008083357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe1843603018112610a6657600080fd5b83018035915067ffffffffffffffff821115610a8157600080fd5b6020019150600581901b360382131561053d57600080fd5b6000825160005b81811015610aba5760208186018101518583015201610aa0565b506000920191825250919050565b60007fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8203610af957610af9610775565b506001019056fea2646970667358221220b3cbe1e73e67aff5a1b794c7288df89f93702087b540fb7380ff6d9da0b1f59f64736f6c63430008240033",
    "sourceMap":
      "246:2534:0:-:0;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;2198:580;;;;;;:::i;:::-;;:::i;:::-;;1492:700;;;;;;:::i;:::-;;:::i;:::-;;;1980:25:1;;;1968:2;1953:18;1492:700:0;;;;;;;;270:997;;;;;;:::i;:::-;;:::i;:::-;;;;;;;:::i;2198:580::-;2322:53;:9;:53;2318:170;;2467:9;2318:170;2502:9;2497:275;2517:16;;;2497:275;;;2554:18;2575:5;;2581:1;2575:8;;;;;;;:::i;:::-;;;;;;;;;;;;:::i;:::-;2554:29;-1:-1:-1;2611:8:0;;;;2597:11;2637:8;;;2633:29;;2653:9;2647:15;;2633:29;2677:12;2694:11;;;;:4;:11;:::i;:::-;:16;;2716:3;2721:9;;;;:4;:9;:::i;:::-;2694:37;;;;;;;:::i;:::-;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;2676:55;;;2753:7;2745:16;;;;;;-1:-1:-1;;;2535:3:0;;2497:275;;;;2198:580;;:::o;1492:700::-;1620:20;1716:16;1747:9;1735;:21;;;;:::i;:::-;1716:40;;1766:23;1792:12;1797:6;;1792:4;:12::i;:::-;1766:38;;1915:37;1934:8;1922:9;:20;1944:8;1915:37;1967:9;1962:93;1986:7;:14;1982:1;:18;1962:93;;;2042:1;2029:7;2037:1;2029:10;;;;;;;;:::i;:::-;;;;;;;:14;2021:23;;;;;;2002:3;;1962:93;;;;2142:2;2125:9;:14;;2137:2;2125:14;:::i;:::-;:19;;;;:::i;:::-;2154:31;;;;;2110:34;;-1:-1:-1;2154:4:0;;:15;;:31;;2170:14;;;;2154:31;;;:::i;:::-;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;1646:546;;1492:700;;;;;;;:::o;270:997::-;325:25;387:17;:6;403:1;387:17;:::i;:::-;374:31;;;;;;;;:::i;:::-;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;-1:-1:-1;374:31:0;-1:-1:-1;362:43:0;-1:-1:-1;430:4:0;415:12;444:784;510:7;:48;;548:9;540:18;;;:::i;:::-;510:48;;;527:9;510:48;493:9;503:3;493:14;;;;;;;;:::i;:::-;;;;;;;;;;:65;572:31;;;598:5;572:31;617:20;640:6;;647:3;640:11;;;;;;;:::i;:::-;;;;;;;;;;;;:::i;:::-;617:34;;670:7;669:8;:27;;;;-1:-1:-1;681:15:0;;;;:5;:15;:::i;:::-;665:41;;;698:8;;;665:41;757:4;773:9;;;;757:4;799:15;817:11;;;;773:5;817:11;:::i;:::-;784:46;;;;;;;;;:::i;:::-;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;749:82;;;;-1:-1:-1;749:82:0;:::i;:::-;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;-1:-1:-1;720:111:0;;-1:-1:-1;;911:53:0;:9;:53;907:311;;1099:5;:9;;;1081;:14;;1093:2;1081:14;:::i;:::-;:27;;1073:36;;;;;;1199:4;1189:14;;907:311;479:749;444:784;472:5;;;;:::i;:::-;;;;444:784;;;;1242:18;1250:9;1242:18;;;;;;:::i;:::-;;;;;;;;352:915;270:997;;;;:::o;14:380:1:-;90:8;100:6;154:3;147:4;139:6;135:17;131:27;121:55;;172:1;169;162:12;121:55;-1:-1:-1;195:20:1;;238:18;227:30;;224:50;;;270:1;267;260:12;224:50;307:4;299:6;295:17;283:29;;367:3;360:4;350:6;347:1;343:14;335:6;331:27;327:38;324:47;321:67;;;384:1;381;374:12;321:67;14:380;;;;;:::o;399:472::-;507:6;515;568:2;556:9;547:7;543:23;539:32;536:52;;;584:1;581;574:12;536:52;624:9;611:23;657:18;649:6;646:30;643:50;;;689:1;686;679:12;643:50;728:83;803:7;794:6;783:9;779:22;728:83;:::i;:::-;830:8;;702:109;;-1:-1:-1;399:472:1;-1:-1:-1;;;;399:472:1:o;876:953::-;1052:6;1060;1068;1076;1084;1137:2;1125:9;1116:7;1112:23;1108:32;1105:52;;;1153:1;1150;1143:12;1105:52;1193:9;1180:23;1226:18;1218:6;1215:30;1212:50;;;1258:1;1255;1248:12;1212:50;1297:83;1372:7;1363:6;1352:9;1348:22;1297:83;:::i;:::-;1399:8;;-1:-1:-1;1271:109:1;-1:-1:-1;;1503:2:1;1488:18;;1475:32;;-1:-1:-1;1584:2:1;1569:18;;1556:32;1613:18;1600:32;;1597:52;;;1645:1;1642;1635:12;1597:52;1684:85;1761:7;1750:8;1739:9;1735:24;1684:85;:::i;:::-;876:953;;;;-1:-1:-1;876:953:1;;-1:-1:-1;1788:8:1;;1658:111;876:953;-1:-1:-1;;;876:953:1:o;2494:609::-;2682:2;2694:21;;;2764:13;;2667:18;;;2786:22;;;2634:4;;2865:15;;;2839:2;2824:18;;;2634:4;2908:169;2922:6;2919:1;2916:13;2908:169;;;2983:13;;2971:26;;3026:2;3052:15;;;;3017:12;;;;2944:1;2937:9;2908:169;;;-1:-1:-1;3094:3:1;;2494:609;-1:-1:-1;;;;;2494:609:1:o;3108:184::-;3160:77;3157:1;3150:88;3257:4;3254:1;3247:15;3281:4;3278:1;3271:15;3297:378;3385:4;3443:11;3430:25;3533:66;3522:8;3506:14;3502:29;3498:102;3478:18;3474:127;3464:155;;3615:1;3612;3605:12;3464:155;3636:33;;;;;3297:378;-1:-1:-1;;3297:378:1:o;3680:196::-;3748:20;;3808:42;3797:54;;3787:65;;3777:93;;3866:1;3863;3856:12;3777:93;3680:196;;;:::o;3881:186::-;3940:6;3993:2;3981:9;3972:7;3968:23;3964:32;3961:52;;;4009:1;4006;3999:12;3961:52;4032:29;4051:9;4032:29;:::i;:::-;4022:39;3881:186;-1:-1:-1;;;3881:186:1:o;4072:580::-;4149:4;4155:6;4215:11;4202:25;4305:66;4294:8;4278:14;4274:29;4270:102;4250:18;4246:127;4236:155;;4387:1;4384;4377:12;4236:155;4414:33;;4466:20;;;-1:-1:-1;4509:18:1;4498:30;;4495:50;;;4541:1;4538;4531:12;4495:50;4574:4;4562:17;;-1:-1:-1;4605:14:1;4601:27;;;4591:38;;4588:58;;;4642:1;4639;4632:12;4657:271;4840:6;4832;4827:3;4814:33;4796:3;4866:16;;4891:13;;;4866:16;4657:271;-1:-1:-1;4657:271:1:o;4933:184::-;4985:77;4982:1;4975:88;5082:4;5079:1;5072:15;5106:4;5103:1;5096:15;5122:128;5189:9;;;5210:11;;;5207:37;;;5224:18;;:::i;:::-;5122:128;;;;:::o;5255:168::-;5328:9;;;5359;;5376:15;;;5370:22;;5356:37;5346:71;;5397:18;;:::i;5428:274::-;5468:1;5494;5484:189;;5529:77;5526:1;5519:88;5630:4;5627:1;5620:15;5658:4;5655:1;5648:15;5484:189;-1:-1:-1;5687:9:1;;5428:274::o;5707:2157::-;5949:2;5961:21;;;5934:18;;6017:22;;;-1:-1:-1;6070:2:1;6119:1;6115:14;;;6100:30;;6096:39;;;6055:18;;6158:6;-1:-1:-1;6235:66:1;6210:14;6206:27;;;6202:100;6311:1524;6325:6;6322:1;6319:13;6311:1524;;;6414:66;6402:9;6394:6;6390:22;6386:95;6381:3;6374:108;6534:6;6521:20;6588:2;6568:18;6564:27;6554:55;;6605:1;6602;6595:12;6554:55;6635:31;;6725:42;6698:25;6635:31;6698:25;:::i;:::-;6694:74;6686:6;6679:90;6834:2;6827:5;6823:14;6810:28;6919:66;6911:5;6895:14;6891:26;6887:99;6865:20;6861:126;6851:154;;7001:1;6998;6991:12;6851:154;7033:32;;7154:2;7141:16;;;7092:21;7184:18;7173:30;;7170:50;;;7216:1;7213;7206:12;7170:50;7269:6;7253:14;7249:27;7240:7;7236:41;7233:61;;;7290:1;7287;7280:12;7233:61;7331:4;7326:2;7318:6;7314:15;7307:29;7375:6;7368:4;7360:6;7356:17;7349:33;7435:6;7426:7;7420:3;7412:6;7408:16;7395:47;7493:1;7487:3;7478:6;7470;7466:19;7462:29;7455:40;7523:1;7508:16;;7572:2;7565:5;7561:14;7548:28;7537:39;;7613:7;7608:2;7600:6;7596:15;7589:32;7751:3;7681:66;7676:2;7668:6;7664:15;7660:88;7652:6;7648:101;7644:111;7634:121;;;;;7790:2;7782:6;7778:15;7768:25;;7822:2;7817:3;7813:12;7806:19;;6347:1;6344;6340:9;6335:14;;6311:1524;;;-1:-1:-1;7852:6:1;;5707:2157;-1:-1:-1;;;;;;;5707:2157:1:o;7869:125::-;7934:9;;;7955:10;;;7952:36;;;7968:18;;:::i;7999:184::-;8051:77;8048:1;8041:88;8148:4;8145:1;8138:15;8172:4;8169:1;8162:15;8188:191;8223:3;8254:66;8247:5;8244:77;8241:103;;8324:18;;:::i;:::-;-1:-1:-1;8364:1:1;8360:13;;8188:191::o;8768:273::-;8824:6;8877:2;8865:9;8856:7;8852:23;8848:32;8845:52;;;8893:1;8890;8883:12;8845:52;8932:9;8919:23;8985:5;8978:13;8971:21;8964:5;8961:32;8951:60;;9007:1;9004;8997:12;9046:626;9161:4;9167:6;9227:11;9214:25;9317:66;9306:8;9290:14;9286:29;9282:102;9262:18;9258:127;9248:155;;9399:1;9396;9389:12;9248:155;9426:33;;9478:20;;;-1:-1:-1;9521:18:1;9510:30;;9507:50;;;9553:1;9550;9543:12;9507:50;9586:4;9574:17;;-1:-1:-1;9637:1:1;9633:14;;;9617;9613:35;9603:46;;9600:66;;;9662:1;9659;9652:12;9677:412;9806:3;9844:6;9838:13;9869:1;9879:129;9893:6;9890:1;9887:13;9879:129;;;9991:4;9975:14;;;9971:25;;9965:32;9952:11;;;9945:53;9908:12;9879:129;;;-1:-1:-1;10063:1:1;10027:16;;10052:13;;;-1:-1:-1;10027:16:1;9677:412;-1:-1:-1;9677:412:1:o;10094:195::-;10133:3;10164:66;10157:5;10154:77;10151:103;;10234:18;;:::i;:::-;-1:-1:-1;10281:1:1;10270:13;;10094:195::o",
    "linkReferences": {},
  },
  "methodIdentifiers": {
    "exec((bool,uint256,(address,bytes,uint256)[])[])": "f6cc90ce",
    "execNext((bool,uint256,(address,bytes,uint256)[])[],uint256,(address,bytes,uint256)[])":
      "b8ce26f9",
    "execSingle((address,bytes,uint256)[])": "5835cb80",
  },
  "rawMetadata":
    '{"compiler":{"version":"0.8.36+commit.8a079791"},"language":"Solidity","output":{"abi":[{"anonymous":false,"inputs":[{"indexed":false,"internalType":"int256[]","name":"gasReport","type":"int256[]"}],"name":"Receipt","type":"event"},{"inputs":[{"components":[{"internalType":"bool","name":"needsPrev","type":"bool"},{"internalType":"uint256","name":"gas","type":"uint256"},{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bytes","name":"data","type":"bytes"},{"internalType":"uint256","name":"gas","type":"uint256"}],"internalType":"struct Call[]","name":"calls","type":"tuple[]"}],"internalType":"struct Burst[]","name":"bursts","type":"tuple[]"}],"name":"exec","outputs":[{"internalType":"int256[]","name":"gasReport","type":"int256[]"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"components":[{"internalType":"bool","name":"needsPrev","type":"bool"},{"internalType":"uint256","name":"gas","type":"uint256"},{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bytes","name":"data","type":"bytes"},{"internalType":"uint256","name":"gas","type":"uint256"}],"internalType":"struct Call[]","name":"calls","type":"tuple[]"}],"internalType":"struct Burst[]","name":"bursts","type":"tuple[]"},{"internalType":"uint256","name":"burstsGas","type":"uint256"},{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bytes","name":"data","type":"bytes"},{"internalType":"uint256","name":"gas","type":"uint256"}],"internalType":"struct Call[]","name":"nextBurstCalls","type":"tuple[]"}],"name":"execNext","outputs":[{"internalType":"uint256","name":"nextBurstGas","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bytes","name":"data","type":"bytes"},{"internalType":"uint256","name":"gas","type":"uint256"}],"internalType":"struct Call[]","name":"calls","type":"tuple[]"}],"name":"execSingle","outputs":[],"stateMutability":"nonpayable","type":"function"}],"devdoc":{"kind":"dev","methods":{"execNext((bool,uint256,(address,bytes,uint256)[])[],uint256,(address,bytes,uint256)[])":{"params":{"burstsGas":"The gas needed to execute `bursts`. It must be at least entire gas needed to call `exec`, including any leftover gas, but it may exclude the TX overhead, e.g. the calldata cost."}}},"version":1},"userdoc":{"kind":"user","methods":{},"version":1}},"settings":{"compilationTarget":{"src/Executor.sol":"Executor"},"evmVersion":"constantinople","libraries":{},"metadata":{"bytecodeHash":"ipfs"},"optimizer":{"enabled":true,"runs":1000000},"remappings":[":forge-std/=lib/forge-std/src/"]},"sources":{"src/Executor.sol":{"keccak256":"0x201ba6379db5461a620888cef41681c2ec51148341f6ebd896d29a9da8a191c0","license":"GPL-3.0-only","urls":["bzz-raw://20a1a10c0253850b8770dec94f976b683d084b47873e0c71d80c65c2d0bbd0c2","dweb:/ipfs/QmemUWE36un2T9MuMFD8XinQSKexJvwJps2MqNrkb2Y9zE"]}},"version":1}',
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
              "internalType": "int256[]",
              "name": "gasReport",
              "type": "int256[]",
              "indexed": false,
            },
          ],
          "type": "event",
          "name": "Receipt",
          "anonymous": false,
        },
        {
          "inputs": [
            {
              "internalType": "struct Burst[]",
              "name": "bursts",
              "type": "tuple[]",
              "components": [
                {
                  "internalType": "bool",
                  "name": "needsPrev",
                  "type": "bool",
                },
                {
                  "internalType": "uint256",
                  "name": "gas",
                  "type": "uint256",
                },
                {
                  "internalType": "struct Call[]",
                  "name": "calls",
                  "type": "tuple[]",
                  "components": [
                    {
                      "internalType": "address",
                      "name": "target",
                      "type": "address",
                    },
                    {
                      "internalType": "bytes",
                      "name": "data",
                      "type": "bytes",
                    },
                    {
                      "internalType": "uint256",
                      "name": "gas",
                      "type": "uint256",
                    },
                  ],
                },
              ],
            },
          ],
          "stateMutability": "nonpayable",
          "type": "function",
          "name": "exec",
          "outputs": [
            {
              "internalType": "int256[]",
              "name": "gasReport",
              "type": "int256[]",
            },
          ],
        },
        {
          "inputs": [
            {
              "internalType": "struct Burst[]",
              "name": "bursts",
              "type": "tuple[]",
              "components": [
                {
                  "internalType": "bool",
                  "name": "needsPrev",
                  "type": "bool",
                },
                {
                  "internalType": "uint256",
                  "name": "gas",
                  "type": "uint256",
                },
                {
                  "internalType": "struct Call[]",
                  "name": "calls",
                  "type": "tuple[]",
                  "components": [
                    {
                      "internalType": "address",
                      "name": "target",
                      "type": "address",
                    },
                    {
                      "internalType": "bytes",
                      "name": "data",
                      "type": "bytes",
                    },
                    {
                      "internalType": "uint256",
                      "name": "gas",
                      "type": "uint256",
                    },
                  ],
                },
              ],
            },
            {
              "internalType": "uint256",
              "name": "burstsGas",
              "type": "uint256",
            },
            {
              "internalType": "struct Call[]",
              "name": "nextBurstCalls",
              "type": "tuple[]",
              "components": [
                {
                  "internalType": "address",
                  "name": "target",
                  "type": "address",
                },
                {
                  "internalType": "bytes",
                  "name": "data",
                  "type": "bytes",
                },
                {
                  "internalType": "uint256",
                  "name": "gas",
                  "type": "uint256",
                },
              ],
            },
          ],
          "stateMutability": "nonpayable",
          "type": "function",
          "name": "execNext",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "nextBurstGas",
              "type": "uint256",
            },
          ],
        },
        {
          "inputs": [
            {
              "internalType": "struct Call[]",
              "name": "calls",
              "type": "tuple[]",
              "components": [
                {
                  "internalType": "address",
                  "name": "target",
                  "type": "address",
                },
                {
                  "internalType": "bytes",
                  "name": "data",
                  "type": "bytes",
                },
                {
                  "internalType": "uint256",
                  "name": "gas",
                  "type": "uint256",
                },
              ],
            },
          ],
          "stateMutability": "nonpayable",
          "type": "function",
          "name": "execSingle",
        },
      ],
      "devdoc": {
        "kind": "dev",
        "methods": {
          "execNext((bool,uint256,(address,bytes,uint256)[])[],uint256,(address,bytes,uint256)[])":
            {
              "params": {
                "burstsGas":
                  "The gas needed to execute `bursts`. It must be at least entire gas needed to call `exec`, including any leftover gas, but it may exclude the TX overhead, e.g. the calldata cost.",
              },
            },
        },
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
        "src/Executor.sol": "Executor",
      },
      "evmVersion": "constantinople",
      "libraries": {},
    },
    "sources": {
      "src/Executor.sol": {
        "keccak256": "0x201ba6379db5461a620888cef41681c2ec51148341f6ebd896d29a9da8a191c0",
        "urls": [
          "bzz-raw://20a1a10c0253850b8770dec94f976b683d084b47873e0c71d80c65c2d0bbd0c2",
          "dweb:/ipfs/QmemUWE36un2T9MuMFD8XinQSKexJvwJps2MqNrkb2Y9zE",
        ],
        "license": "GPL-3.0-only",
      },
    },
    "version": 1,
  },
  "id": 0,
} as const;
export const executorAbi = executorArtifact.abi satisfies Abi;
export const executorBytecode = executorArtifact.bytecode.object satisfies Hex;
