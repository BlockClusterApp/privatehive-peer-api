const shell = require('shelljs')
const toPascalCase = require('to-pascal-case')
const fs = require('fs')
const yaml = require('json2yaml');
require('./apis')

const orgName = toPascalCase(process.env.ORG_NAME)
const shareFileDir = process.env.SHARE_FILE_DIR || './crypto'
const workerNodeIP = process.env.WORKER_NODE_IP || '127.0.0.1'
const anchorPort = process.env.ANCHOR_PORT || 7051

if(!fs.existsSync(shareFileDir + "initCompleted")) {
  const cryptoConfigYaml = `
    PeerOrgs:
      - Name: ${orgName}
        Domain: peer.${orgName.toLowerCase()}.com
        Template:
          Count: 1 
        Users:
          Count: 1
    `

  shell.mkdir('-p', shareFileDir)
  shell.cd(shareFileDir)
  fs.writeFileSync('./crypto-config.yaml', cryptoConfigYaml)
  shell.exec('cryptogen generate --config=./crypto-config.yaml')

  const configTxYaml = `
    Organizations:
    - &${orgName}
      Name: ${orgName}
      ID: ${orgName}
      MSPDir: crypto-config/peerOrganizations/peer.${orgName.toLowerCase()}.com/msp
      AnchorPeers:
        - Host: ${workerNodeIP}
          Port: ${anchorPort}
    Profiles:
      OneOrgChannel:
        Consortium: SingleMemberConsortium
        Application:
            Organizations:
                - *${orgName}

    Channel: &ChannelDefaults
      Policies:
        Readers:
          Type: ImplicitMeta
          Rule: "ANY Readers"
        Writers:
          Type: ImplicitMeta
          Rule: "ANY Writers"
        Admins:
          Type: ImplicitMeta
          Rule: "ANY Admins"
  `

  fs.writeFileSync('./configtx.yaml', configTxYaml)
  shell.exec(`FABRIC_CFG_PATH=$PWD configtxgen -printOrg ${orgName} > ${orgName.toLowerCase()}.json`)

  let files = fs.readdirSync(`crypto-config/peerOrganizations/peer.${orgName.toLowerCase()}.com/ca/`)
  files.forEach(fileName => {
    if(fileName.indexOf('_sk') > -1) {
      shell.exec(`mv crypto-config/peerOrganizations/peer.${orgName.toLowerCase()}.com/ca/${fileName} crypto-config/peerOrganizations/peer.${orgName.toLowerCase()}.com/ca/privateKey`)
    }
  })

  files = fs.readdirSync(`crypto-config/peerOrganizations/peer.${orgName.toLowerCase()}.com/users/Admin@peer.${orgName.toLowerCase()}.com/msp/keystore/`)
  files.forEach(fileName => {
    if(fileName.indexOf('_sk') > -1) {
      shell.exec(`mv crypto-config/peerOrganizations/peer.${orgName.toLowerCase()}.com/users/Admin@peer.${orgName.toLowerCase()}.com/msp/keystore/${fileName} crypto-config/peerOrganizations/peer.${orgName.toLowerCase()}.com/users/Admin@peer.${orgName.toLowerCase()}.com/msp/keystore/privateKey`)
    }
  })

  let networkMap = {
    "name": "privatehive",
    "x-type": "hlfv1",
    "version": "1.0",
    "channels": {
      /*
      "sample": {
        "orderers": [
          "orderer.blockcluster.com"
        ],
        "peers": {
          "peer0.peer.blockcluster.com": {
            "chaincodeQuery": true,
            "ledgerQuery": true,
            "eventSource": true
          }
        },
        "chaincodes": [
          "mycc:v0"
        ]
      }
      */
    },
    "organizations": {},
    "orderers": {},
    "peers": {},
    "certificateAuthorities": {},
    "client": {
      "organization": orgName,
      "credentialStore": {
        "path": `./fabric-client-kv-${orgName.toLowerCase()}`,
        "cryptoStore": {
          "path": `./fabric-client-kv-${orgName.toLowerCase()}`
        },
        "wallet": "wallet-name"
      }
    }
  }

  networkMap.organizations[orgName] = {
    "mspid": orgName,
    "peers": [
      `peer0.peer.${orgName.toLowerCase()}.com`
    ],
    "certificateAuthorities": [
      `ca-${orgName.toLowerCase()}`
    ],
    "adminPrivateKey": {
      "path": `crypto-config/peerOrganizations/peer.${orgName.toLowerCase()}.com/users/Admin@peer.${orgName.toLowerCase()}.com/msp/keystore/privatekey`
    },
    "signedCert": {
      "path": `crypto-config/peerOrganizations/peer.${orgName.toLowerCase()}.com/users/Admin@peer.${orgName.toLowerCase()}.com/msp/signcerts/Admin@peer.${orgName.toLowerCase()}.com-cert.pem`
    }
  }

  networkMap.peers[`peer0.peer.${orgName.toLowerCase()}.com`] =  {
    "url": "grpc://localhost:7051"
  }

  networkMap.certificateAuthorities[`ca-${orgName.toLowerCase()}`] = {
    "url": "http://localhost:7054",
    "httpOptions": {
      "verify": false
    },
    "registrar": [
      {
        "enrollId": "admin",
        "enrollSecret": "adminpw"
      }
    ],
    "caName": `ca-${orgName.toLowerCase()}`
  }

  networkMap = yaml.stringify(networkMap);

  fs.writeFileSync('./network-map.yaml', networkMap)

  fs.writeFileSync('./initCompleted', "initCompleted")
}