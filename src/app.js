const shell = require('shelljs')
const toPascalCase = require('to-pascal-case')
const fs = require('fs')
const yamlJs = require('json2yaml')
const MongoClient = require("mongodb").MongoClient
const Config = require('./config');

require('./apis')

const orgName = toPascalCase(process.env.ORG_NAME) || 'Blockcluster'
const shareFileDir = process.env.SHARE_FILE_DIR || './crypto'
const workerNodeIP = process.env.WORKER_NODE_IP || '127.0.0.1'
const anchorPort = process.env.ANCHOR_PORT || 7051
const instanceId = process.env.INSTANCE_ID
const caPort = process.env.CA_PORT || 7054

async function updateStatus() {
  return new Promise((resolve, reject) => {
    MongoClient.connect(
      Config.getMongoConnectionString(),
      {
        reconnectTries: Number.MAX_VALUE,
        autoReconnect: true,
        useNewUrlParser: true
      },
      function(err, database) {
        if (!err) {
          let db = database.db(Config.getDatabase());
          db.collection("privatehivePeers").updateOne(
            { instanceId },
            { $set: { status: "running" } },
            function(err, res) {
              if(err) {
                reject()
              } else {
                resolve()
              }
            }
          );
        } else {
          reject()
        }
      }
    );
  })
}

(async () => {
  if(!fs.existsSync(shareFileDir + "/initCompleted")) {
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

    files = fs.readdirSync(`crypto-config/peerOrganizations/peer.${orgName.toLowerCase()}.com/peers/peer0.peer.${orgName.toLowerCase()}.com/msp/keystore/`)
    files.forEach(fileName => {
      if(fileName.indexOf('_sk') > -1) {
        shell.exec(`mv crypto-config/peerOrganizations/peer.${orgName.toLowerCase()}.com/peers/peer0.peer.${orgName.toLowerCase()}.com/msp/keystore/${fileName} crypto-config/peerOrganizations/peer.${orgName.toLowerCase()}.com/peers/peer0.peer.${orgName.toLowerCase()}.com/msp/keystore/privateKey`)
      }
    })

    shell.exec(`discover --configFile discover_conf.yaml --userKey crypto-config/peerOrganizations/peer.${orgName.toLowerCase()}.com/peers/peer0.peer.${orgName.toLowerCase()}.com/msp/keystore/privateKey --userCert crypto-config/peerOrganizations/peer.${orgName.toLowerCase()}.com/peers/peer0.peer.${orgName.toLowerCase()}.com/msp/signcerts/peer0.peer.${orgName.toLowerCase()}.com-cert.pem  --MSP ${orgName} saveConfig`)
  
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
        "path": `crypto-config/peerOrganizations/peer.${orgName.toLowerCase()}.com/users/Admin@peer.${orgName.toLowerCase()}.com/msp/keystore/privateKey`
      },
      "signedCert": {
        "path": `crypto-config/peerOrganizations/peer.${orgName.toLowerCase()}.com/users/Admin@peer.${orgName.toLowerCase()}.com/msp/signcerts/Admin@peer.${orgName.toLowerCase()}.com-cert.pem`
      }
    }
  
    networkMap.peers[`peer0.peer.${orgName.toLowerCase()}.com`] =  {
      "url": `grpc://${workerNodeIP}:${anchorPort}`
    }
  
    networkMap.certificateAuthorities[`ca-${orgName.toLowerCase()}`] = {
      "url":  `http://${workerNodeIP}:${caPort}`,
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
  
    networkMap = yamlJs.stringify(networkMap);
  
    fs.writeFileSync('./network-map.yaml', networkMap)
  
    await updateStatus()
  
    fs.writeFileSync('./initCompleted', "initCompleted")
  }
})()



//spawn('configtxlator start &');