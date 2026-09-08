// DO NOT EDIT, code generated with task `generate-contracts`
import type { Abi, Hex } from "viem";

const artifact = {
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
      "0x6080604052348015600f57600080fd5b50610b108061001f6000396000f3fe608060405234801561001057600080fd5b50600436106100415760003560e01c80635835cb8014610046578063b8ce26f91461005b578063f6cc90ce14610081575b600080fd5b61005961005436600461052e565b6100a1565b005b61006e610069366004610570565b61019a565b6040519081526020015b60405180910390f35b61009461008f36600461052e565b610292565b60405161007891906105ef565b7fffffffffffffffffffffffffba879a9c8a8b908ddfd2df9b8d9e9691df989e8d32016100ce575b6100c9565b60005b8181101561019557368383838181106100ec576100ec610632565b90506020028101906100fe9190610661565b905060408101356000819003610112575a90505b600061012160208401846106c8565b9050600061013260208501856106ea565b8080601f0160208091040260200160405190810160405280939291908181526020018383808284376000920182905250845194955093849350839250905060208501828789f190508061018457600080fd5b5050600190930192506100d1915050565b505050565b600080845a6101a9919061077e565b905060006101b78888610292565b90505b815a116101ba5760005b81518110156101fb5760008282815181106101e1576101e1610632565b6020026020010151136101f357600080fd5b6001016101c4565b5060405a61020a90603f610797565b61021491906107ae565b6040517f5835cb800000000000000000000000000000000000000000000000000000000081529093503090635835cb809061025590889088906004016107e9565b600060405180830381600087803b15801561026f57600080fd5b505af1158015610283573d6000803e3d6000fd5b50505050505095945050505050565b606061029f82600161096f565b67ffffffffffffffff8111156102b7576102b7610982565b6040519080825280602002602001820160405280156102e0578160200160208202803683370190505b509050600160005b816102fc575a6102f7906109b1565b6102fe565b5a5b83828151811061031057610310610632565b60209081029190910101528084146104a3573685858381811061033557610335610632565b90506020028101906103479190610661565b90508215801561035f575061035f60208201826109e9565b1561036a5750610491565b30602082013581635835cb806103836040860186610a0b565b6040516024016103949291906107e9565b604080517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08184030181529181526020820180517bffffffffffffffffffffffffffffffffffffffffffffffffffffffff1660e09490941b9390931790925290516103ff9250610a73565b60006040518083038160008787f1925050503d806000811461043d576040519150601f19603f3d011682016040523d82523d6000602084013e610442565b606091505b50909350507fffffffffffffffffffffffffba879a9c8a8b908ddfd2df9b8d9e9691df989e8d320161048f5780602001355a61047f90603f610797565b101561048a57600080fd5b600192505b505b8061049b81610aa2565b9150506102e8565b507f2f11af55833ef785aecc862ba1c283298eea75cf957861fcf5c922ece0b27315826040516104d391906105ef565b60405180910390a15092915050565b60008083601f8401126104f457600080fd5b50813567ffffffffffffffff81111561050c57600080fd5b6020830191508360208260051b850101111561052757600080fd5b9250929050565b6000806020838503121561054157600080fd5b823567ffffffffffffffff81111561055857600080fd5b610564858286016104e2565b90969095509350505050565b60008060008060006060868803121561058857600080fd5b853567ffffffffffffffff81111561059f57600080fd5b6105ab888289016104e2565b90965094505060208601359250604086013567ffffffffffffffff8111156105d257600080fd5b6105de888289016104e2565b969995985093965092949392505050565b602080825282518282018190526000918401906040840190835b81811015610627578351835260209384019390920191600101610609565b509095945050505050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052603260045260246000fd5b600082357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa183360301811261069557600080fd5b9190910192915050565b803573ffffffffffffffffffffffffffffffffffffffff811681146106c357600080fd5b919050565b6000602082840312156106da57600080fd5b6106e38261069f565b9392505050565b60008083357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe184360301811261071f57600080fd5b83018035915067ffffffffffffffff82111561073a57600080fd5b60200191503681900382131561052757600080fd5b7f4e487b7100000000000000000000000000000000000000000000000000000000600052601160045260246000fd5b818103818111156107915761079161074f565b92915050565b80820281158282048414176107915761079161074f565b6000826107e4577f4e487b7100000000000000000000000000000000000000000000000000000000600052601260045260246000fd5b500490565b6020808252810182905260006040600584901b8301810190830185837fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa136839003015b87821015610962577fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc0878603018452823581811261086957600080fd5b890173ffffffffffffffffffffffffffffffffffffffff6108898261069f565b16865260208101357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe18236030181126108c157600080fd5b810160208101903567ffffffffffffffff8111156108de57600080fd5b8036038213156108ed57600080fd5b60606020890152806060890152808260808a013760006080828a010152600091506040830135915081604089015260807fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0601f830116890101975050505060208301925060208401935060018201915061082c565b5092979650505050505050565b808201808211156107915761079161074f565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052604160045260246000fd5b60007f800000000000000000000000000000000000000000000000000000000000000082036109e2576109e261074f565b5060000390565b6000602082840312156109fb57600080fd5b813580151581146106e357600080fd5b60008083357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe1843603018112610a4057600080fd5b83018035915067ffffffffffffffff821115610a5b57600080fd5b6020019150600581901b360382131561052757600080fd5b6000825160005b81811015610a945760208186018101518583015201610a7a565b506000920191825250919050565b60007fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8203610ad357610ad361074f565b506001019056fea2646970667358221220f27c75610b49ce2ea98b03019db3cc3648f6bfc34bc7596f293aa1baf16f8d7364736f6c63430008240033",
    "sourceMap": "210:3497:0:-:0;;;;;;;;;;;;;;;;;;;",
    "linkReferences": {},
  },
  "deployedBytecode": {
    "object":
      "0x608060405234801561001057600080fd5b50600436106100415760003560e01c80635835cb8014610046578063b8ce26f91461005b578063f6cc90ce14610081575b600080fd5b61005961005436600461052e565b6100a1565b005b61006e610069366004610570565b61019a565b6040519081526020015b60405180910390f35b61009461008f36600461052e565b610292565b60405161007891906105ef565b7fffffffffffffffffffffffffba879a9c8a8b908ddfd2df9b8d9e9691df989e8d32016100ce575b6100c9565b60005b8181101561019557368383838181106100ec576100ec610632565b90506020028101906100fe9190610661565b905060408101356000819003610112575a90505b600061012160208401846106c8565b9050600061013260208501856106ea565b8080601f0160208091040260200160405190810160405280939291908181526020018383808284376000920182905250845194955093849350839250905060208501828789f190508061018457600080fd5b5050600190930192506100d1915050565b505050565b600080845a6101a9919061077e565b905060006101b78888610292565b90505b815a116101ba5760005b81518110156101fb5760008282815181106101e1576101e1610632565b6020026020010151136101f357600080fd5b6001016101c4565b5060405a61020a90603f610797565b61021491906107ae565b6040517f5835cb800000000000000000000000000000000000000000000000000000000081529093503090635835cb809061025590889088906004016107e9565b600060405180830381600087803b15801561026f57600080fd5b505af1158015610283573d6000803e3d6000fd5b50505050505095945050505050565b606061029f82600161096f565b67ffffffffffffffff8111156102b7576102b7610982565b6040519080825280602002602001820160405280156102e0578160200160208202803683370190505b509050600160005b816102fc575a6102f7906109b1565b6102fe565b5a5b83828151811061031057610310610632565b60209081029190910101528084146104a3573685858381811061033557610335610632565b90506020028101906103479190610661565b90508215801561035f575061035f60208201826109e9565b1561036a5750610491565b30602082013581635835cb806103836040860186610a0b565b6040516024016103949291906107e9565b604080517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08184030181529181526020820180517bffffffffffffffffffffffffffffffffffffffffffffffffffffffff1660e09490941b9390931790925290516103ff9250610a73565b60006040518083038160008787f1925050503d806000811461043d576040519150601f19603f3d011682016040523d82523d6000602084013e610442565b606091505b50909350507fffffffffffffffffffffffffba879a9c8a8b908ddfd2df9b8d9e9691df989e8d320161048f5780602001355a61047f90603f610797565b101561048a57600080fd5b600192505b505b8061049b81610aa2565b9150506102e8565b507f2f11af55833ef785aecc862ba1c283298eea75cf957861fcf5c922ece0b27315826040516104d391906105ef565b60405180910390a15092915050565b60008083601f8401126104f457600080fd5b50813567ffffffffffffffff81111561050c57600080fd5b6020830191508360208260051b850101111561052757600080fd5b9250929050565b6000806020838503121561054157600080fd5b823567ffffffffffffffff81111561055857600080fd5b610564858286016104e2565b90969095509350505050565b60008060008060006060868803121561058857600080fd5b853567ffffffffffffffff81111561059f57600080fd5b6105ab888289016104e2565b90965094505060208601359250604086013567ffffffffffffffff8111156105d257600080fd5b6105de888289016104e2565b969995985093965092949392505050565b602080825282518282018190526000918401906040840190835b81811015610627578351835260209384019390920191600101610609565b509095945050505050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052603260045260246000fd5b600082357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa183360301811261069557600080fd5b9190910192915050565b803573ffffffffffffffffffffffffffffffffffffffff811681146106c357600080fd5b919050565b6000602082840312156106da57600080fd5b6106e38261069f565b9392505050565b60008083357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe184360301811261071f57600080fd5b83018035915067ffffffffffffffff82111561073a57600080fd5b60200191503681900382131561052757600080fd5b7f4e487b7100000000000000000000000000000000000000000000000000000000600052601160045260246000fd5b818103818111156107915761079161074f565b92915050565b80820281158282048414176107915761079161074f565b6000826107e4577f4e487b7100000000000000000000000000000000000000000000000000000000600052601260045260246000fd5b500490565b6020808252810182905260006040600584901b8301810190830185837fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa136839003015b87821015610962577fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc0878603018452823581811261086957600080fd5b890173ffffffffffffffffffffffffffffffffffffffff6108898261069f565b16865260208101357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe18236030181126108c157600080fd5b810160208101903567ffffffffffffffff8111156108de57600080fd5b8036038213156108ed57600080fd5b60606020890152806060890152808260808a013760006080828a010152600091506040830135915081604089015260807fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0601f830116890101975050505060208301925060208401935060018201915061082c565b5092979650505050505050565b808201808211156107915761079161074f565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052604160045260246000fd5b60007f800000000000000000000000000000000000000000000000000000000000000082036109e2576109e261074f565b5060000390565b6000602082840312156109fb57600080fd5b813580151581146106e357600080fd5b60008083357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe1843603018112610a4057600080fd5b83018035915067ffffffffffffffff821115610a5b57600080fd5b6020019150600581901b360382131561052757600080fd5b6000825160005b81811015610a945760208186018101518583015201610a7a565b506000920191825250919050565b60007fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8203610ad357610ad361074f565b506001019056fea2646970667358221220f27c75610b49ce2ea98b03019db3cc3648f6bfc34bc7596f293aa1baf16f8d7364736f6c63430008240033",
    "sourceMap":
      "210:3497:0:-:0;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;2771:934;;;;;;:::i;:::-;;:::i;:::-;;1911:854;;;;;;:::i;:::-;;:::i;:::-;;;1980:25:1;;;1968:2;1953:18;1911:854:0;;;;;;;;274:1412;;;;;;:::i;:::-;;:::i;:::-;;;;;;;:::i;2771:934::-;2906:53;:9;:53;2902:154;;3024:21;3037:8;3024:21;;3070:9;3065:634;3085:16;;;3065:634;;;3122:22;3147:5;;3153:1;3147:8;;;;;;;:::i;:::-;;;;;;;;;;;;:::i;:::-;3122:33;-1:-1:-1;3188:12:0;;;;3169:16;3218:13;;;3214:39;;3244:9;3233:20;;3214:39;3267:14;3284:15;;;;:8;:15;:::i;:::-;3267:32;-1:-1:-1;3313:17:0;3333:13;;;;:8;:13;:::i;:::-;3313:33;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;-1:-1:-1;3543:11:0;;3313:33;;-1:-1:-1;3313:33:0;;;-1:-1:-1;3313:33:0;;-1:-1:-1;3543:11:0;-1:-1:-1;3538:2:0;3528:13;;3313:33;3517:6;3507:8;3502:59;3491:70;;3680:7;3672:16;;;;;;-1:-1:-1;;3103:3:0;;;;;-1:-1:-1;3065:634:0;;-1:-1:-1;;3065:634:0;;;2771:934;;:::o;1911:854::-;2039:20;2135:16;2166:9;2154;:21;;;;:::i;:::-;2135:40;;2185:23;2211:12;2216:6;;2211:4;:12::i;:::-;2185:38;;2334:37;2353:8;2341:9;:20;2363:8;2334:37;2386:9;2381:177;2405:7;:14;2401:1;:18;2381:177;;;2545:1;2532:7;2540:1;2532:10;;;;;;;;:::i;:::-;;;;;;;:14;2524:23;;;;;;2421:3;;2381:177;;;;2715:2;2698:9;:14;;2710:2;2698:14;:::i;:::-;:19;;;;:::i;:::-;2727:31;;;;;2683:34;;-1:-1:-1;2727:4:0;;:15;;:31;;2743:14;;;;2727:31;;;:::i;:::-;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;2065:700;;1911:854;;;;;;;:::o;274:1412::-;329:25;391:17;:6;407:1;391:17;:::i;:::-;378:31;;;;;;;;:::i;:::-;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;-1:-1:-1;378:31:0;-1:-1:-1;366:43:0;-1:-1:-1;434:4:0;419:12;502:1085;630:7;:48;;668:9;660:18;;;:::i;:::-;630:48;;;647:9;630:48;613:9;623:3;613:14;;;;;;;;:::i;:::-;;;;;;;;;;:65;692:31;;;718:5;692:31;737:20;760:6;;767:3;760:11;;;;;;;:::i;:::-;;;;;;;;;;;;:::i;:::-;737:34;;790:7;789:8;:27;;;;-1:-1:-1;801:15:0;;;;:5;:15;:::i;:::-;785:41;;;818:8;;;785:41;964:4;980:9;;;;964:4;1006:15;1024:11;;;;980:5;1024:11;:::i;:::-;991:46;;;;;;;;;:::i;:::-;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;956:82;;;;-1:-1:-1;956:82:0;:::i;:::-;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;-1:-1:-1;927:111:0;;-1:-1:-1;;1129:53:0;:9;:53;1125:452;;1458:5;:9;;;1440;:14;;1452:2;1440:14;:::i;:::-;:27;;1432:36;;;;;;1558:4;1548:14;;1125:452;537:1050;502:1085;530:5;;;;:::i;:::-;;;;502:1085;;;;1661:18;1669:9;1661:18;;;;;;:::i;:::-;;;;;;;;356:1330;274:1412;;;;:::o;14:380:1:-;90:8;100:6;154:3;147:4;139:6;135:17;131:27;121:55;;172:1;169;162:12;121:55;-1:-1:-1;195:20:1;;238:18;227:30;;224:50;;;270:1;267;260:12;224:50;307:4;299:6;295:17;283:29;;367:3;360:4;350:6;347:1;343:14;335:6;331:27;327:38;324:47;321:67;;;384:1;381;374:12;321:67;14:380;;;;;:::o;399:472::-;507:6;515;568:2;556:9;547:7;543:23;539:32;536:52;;;584:1;581;574:12;536:52;624:9;611:23;657:18;649:6;646:30;643:50;;;689:1;686;679:12;643:50;728:83;803:7;794:6;783:9;779:22;728:83;:::i;:::-;830:8;;702:109;;-1:-1:-1;399:472:1;-1:-1:-1;;;;399:472:1:o;876:953::-;1052:6;1060;1068;1076;1084;1137:2;1125:9;1116:7;1112:23;1108:32;1105:52;;;1153:1;1150;1143:12;1105:52;1193:9;1180:23;1226:18;1218:6;1215:30;1212:50;;;1258:1;1255;1248:12;1212:50;1297:83;1372:7;1363:6;1352:9;1348:22;1297:83;:::i;:::-;1399:8;;-1:-1:-1;1271:109:1;-1:-1:-1;;1503:2:1;1488:18;;1475:32;;-1:-1:-1;1584:2:1;1569:18;;1556:32;1613:18;1600:32;;1597:52;;;1645:1;1642;1635:12;1597:52;1684:85;1761:7;1750:8;1739:9;1735:24;1684:85;:::i;:::-;876:953;;;;-1:-1:-1;876:953:1;;-1:-1:-1;1788:8:1;;1658:111;876:953;-1:-1:-1;;;876:953:1:o;2494:609::-;2682:2;2694:21;;;2764:13;;2667:18;;;2786:22;;;2634:4;;2865:15;;;2839:2;2824:18;;;2634:4;2908:169;2922:6;2919:1;2916:13;2908:169;;;2983:13;;2971:26;;3026:2;3052:15;;;;3017:12;;;;2944:1;2937:9;2908:169;;;-1:-1:-1;3094:3:1;;2494:609;-1:-1:-1;;;;;2494:609:1:o;3108:184::-;3160:77;3157:1;3150:88;3257:4;3254:1;3247:15;3281:4;3278:1;3271:15;3297:378;3385:4;3443:11;3430:25;3533:66;3522:8;3506:14;3502:29;3498:102;3478:18;3474:127;3464:155;;3615:1;3612;3605:12;3464:155;3636:33;;;;;3297:378;-1:-1:-1;;3297:378:1:o;3680:196::-;3748:20;;3808:42;3797:54;;3787:65;;3777:93;;3866:1;3863;3856:12;3777:93;3680:196;;;:::o;3881:186::-;3940:6;3993:2;3981:9;3972:7;3968:23;3964:32;3961:52;;;4009:1;4006;3999:12;3961:52;4032:29;4051:9;4032:29;:::i;:::-;4022:39;3881:186;-1:-1:-1;;;3881:186:1:o;4072:580::-;4149:4;4155:6;4215:11;4202:25;4305:66;4294:8;4278:14;4274:29;4270:102;4250:18;4246:127;4236:155;;4387:1;4384;4377:12;4236:155;4414:33;;4466:20;;;-1:-1:-1;4509:18:1;4498:30;;4495:50;;;4541:1;4538;4531:12;4495:50;4574:4;4562:17;;-1:-1:-1;4605:14:1;4601:27;;;4591:38;;4588:58;;;4642:1;4639;4632:12;4657:184;4709:77;4706:1;4699:88;4806:4;4803:1;4796:15;4830:4;4827:1;4820:15;4846:128;4913:9;;;4934:11;;;4931:37;;;4948:18;;:::i;:::-;4846:128;;;;:::o;4979:168::-;5052:9;;;5083;;5100:15;;;5094:22;;5080:37;5070:71;;5121:18;;:::i;5152:274::-;5192:1;5218;5208:189;;5253:77;5250:1;5243:88;5354:4;5351:1;5344:15;5382:4;5379:1;5372:15;5208:189;-1:-1:-1;5411:9:1;;5152:274::o;5431:2157::-;5673:2;5685:21;;;5658:18;;5741:22;;;-1:-1:-1;5794:2:1;5843:1;5839:14;;;5824:30;;5820:39;;;5779:18;;5882:6;-1:-1:-1;5959:66:1;5934:14;5930:27;;;5926:100;6035:1524;6049:6;6046:1;6043:13;6035:1524;;;6138:66;6126:9;6118:6;6114:22;6110:95;6105:3;6098:108;6258:6;6245:20;6312:2;6292:18;6288:27;6278:55;;6329:1;6326;6319:12;6278:55;6359:31;;6449:42;6422:25;6359:31;6422:25;:::i;:::-;6418:74;6410:6;6403:90;6558:2;6551:5;6547:14;6534:28;6643:66;6635:5;6619:14;6615:26;6611:99;6589:20;6585:126;6575:154;;6725:1;6722;6715:12;6575:154;6757:32;;6878:2;6865:16;;;6816:21;6908:18;6897:30;;6894:50;;;6940:1;6937;6930:12;6894:50;6993:6;6977:14;6973:27;6964:7;6960:41;6957:61;;;7014:1;7011;7004:12;6957:61;7055:4;7050:2;7042:6;7038:15;7031:29;7099:6;7092:4;7084:6;7080:17;7073:33;7159:6;7150:7;7144:3;7136:6;7132:16;7119:47;7217:1;7211:3;7202:6;7194;7190:19;7186:29;7179:40;7247:1;7232:16;;7296:2;7289:5;7285:14;7272:28;7261:39;;7337:7;7332:2;7324:6;7320:15;7313:32;7475:3;7405:66;7400:2;7392:6;7388:15;7384:88;7376:6;7372:101;7368:111;7358:121;;;;;7514:2;7506:6;7502:15;7492:25;;7546:2;7541:3;7537:12;7530:19;;6071:1;6068;6064:9;6059:14;;6035:1524;;;-1:-1:-1;7576:6:1;;5431:2157;-1:-1:-1;;;;;;;5431:2157:1:o;7593:125::-;7658:9;;;7679:10;;;7676:36;;;7692:18;;:::i;7723:184::-;7775:77;7772:1;7765:88;7872:4;7869:1;7862:15;7896:4;7893:1;7886:15;7912:191;7947:3;7978:66;7971:5;7968:77;7965:103;;8048:18;;:::i;:::-;-1:-1:-1;8088:1:1;8084:13;;7912:191::o;8492:273::-;8548:6;8601:2;8589:9;8580:7;8576:23;8572:32;8569:52;;;8617:1;8614;8607:12;8569:52;8656:9;8643:23;8709:5;8702:13;8695:21;8688:5;8685:32;8675:60;;8731:1;8728;8721:12;8770:626;8885:4;8891:6;8951:11;8938:25;9041:66;9030:8;9014:14;9010:29;9006:102;8986:18;8982:127;8972:155;;9123:1;9120;9113:12;8972:155;9150:33;;9202:20;;;-1:-1:-1;9245:18:1;9234:30;;9231:50;;;9277:1;9274;9267:12;9231:50;9310:4;9298:17;;-1:-1:-1;9361:1:1;9357:14;;;9341;9337:35;9327:46;;9324:66;;;9386:1;9383;9376:12;9401:412;9530:3;9568:6;9562:13;9593:1;9603:129;9617:6;9614:1;9611:13;9603:129;;;9715:4;9699:14;;;9695:25;;9689:32;9676:11;;;9669:53;9632:12;9603:129;;;-1:-1:-1;9787:1:1;9751:16;;9776:13;;;-1:-1:-1;9751:16:1;9401:412;-1:-1:-1;9401:412:1:o;9818:195::-;9857:3;9888:66;9881:5;9878:77;9875:103;;9958:18;;:::i;:::-;-1:-1:-1;10005:1:1;9994:13;;9818:195::o",
    "linkReferences": {},
  },
  "methodIdentifiers": {
    "exec((bool,uint256,(address,bytes,uint256)[])[])": "f6cc90ce",
    "execNext((bool,uint256,(address,bytes,uint256)[])[],uint256,(address,bytes,uint256)[])":
      "b8ce26f9",
    "execSingle((address,bytes,uint256)[])": "5835cb80",
  },
  "rawMetadata":
    '{"compiler":{"version":"0.8.36+commit.8a079791"},"language":"Solidity","output":{"abi":[{"anonymous":false,"inputs":[{"indexed":false,"internalType":"int256[]","name":"gasReport","type":"int256[]"}],"name":"Receipt","type":"event"},{"inputs":[{"components":[{"internalType":"bool","name":"needsPrev","type":"bool"},{"internalType":"uint256","name":"gas","type":"uint256"},{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bytes","name":"data","type":"bytes"},{"internalType":"uint256","name":"gas","type":"uint256"}],"internalType":"struct Call[]","name":"calls","type":"tuple[]"}],"internalType":"struct Burst[]","name":"bursts","type":"tuple[]"}],"name":"exec","outputs":[{"internalType":"int256[]","name":"gasReport","type":"int256[]"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"components":[{"internalType":"bool","name":"needsPrev","type":"bool"},{"internalType":"uint256","name":"gas","type":"uint256"},{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bytes","name":"data","type":"bytes"},{"internalType":"uint256","name":"gas","type":"uint256"}],"internalType":"struct Call[]","name":"calls","type":"tuple[]"}],"internalType":"struct Burst[]","name":"bursts","type":"tuple[]"},{"internalType":"uint256","name":"burstsGas","type":"uint256"},{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bytes","name":"data","type":"bytes"},{"internalType":"uint256","name":"gas","type":"uint256"}],"internalType":"struct Call[]","name":"nextBurstCalls","type":"tuple[]"}],"name":"execNext","outputs":[{"internalType":"uint256","name":"nextBurstGas","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bytes","name":"data","type":"bytes"},{"internalType":"uint256","name":"gas","type":"uint256"}],"internalType":"struct Call[]","name":"calls","type":"tuple[]"}],"name":"execSingle","outputs":[],"stateMutability":"nonpayable","type":"function"}],"devdoc":{"kind":"dev","methods":{"execNext((bool,uint256,(address,bytes,uint256)[])[],uint256,(address,bytes,uint256)[])":{"params":{"burstsGas":"The gas needed to execute `bursts`. It must be at least entire gas needed to call `exec`, including any leftover gas, but it may exclude the TX overhead, e.g. the calldata cost."}}},"version":1},"userdoc":{"kind":"user","methods":{},"version":1}},"settings":{"compilationTarget":{"src/Executor.sol":"Executor"},"evmVersion":"constantinople","libraries":{},"metadata":{"bytecodeHash":"ipfs"},"optimizer":{"enabled":true,"runs":1000000},"remappings":[":forge-std/=lib/forge-std/src/"]},"sources":{"src/Executor.sol":{"keccak256":"0x3db0e9e3f30c1beb5636ddcb0ac0d3007070b5f0228880fe4b115ffac03e7580","license":"GPL-3.0-only","urls":["bzz-raw://994faa3052a00e13cf04c89f0e5c08bf395e8604f8b6b0caff81998af6ea5b8e","dweb:/ipfs/QmbuQBAteLpRDktXcL1XrxCYkmQnbxnBirfUA7CRnyY1rY"]}},"version":1}',
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
        "keccak256": "0x3db0e9e3f30c1beb5636ddcb0ac0d3007070b5f0228880fe4b115ffac03e7580",
        "urls": [
          "bzz-raw://994faa3052a00e13cf04c89f0e5c08bf395e8604f8b6b0caff81998af6ea5b8e",
          "dweb:/ipfs/QmbuQBAteLpRDktXcL1XrxCYkmQnbxnBirfUA7CRnyY1rY",
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
