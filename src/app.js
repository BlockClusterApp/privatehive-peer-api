const shell = require('shelljs')
const toPascalCase = require('to-pascal-case')
const fs = require('fs')
require('./apis')

const orgName = toPascalCase(process.env.ORG_NAME)
const shareFileDir = process.env.SHARE_FILE_DIR || './crypto'
const workerNodeIP = process.env.WORKER_NODE_IP || '127.0.0.1'
const anchorPort = process.env.ANCHOR_PORT

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

  fs.writeFileSync('./initCompleted', "initCompleted")
}