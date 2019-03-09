const shell = require('shelljs')
const toPascalCase = require('to-pascal-case')
const fs = require('fs')

const orgName = toPascalCase(process.env.ORG_NAME)
const mode = process.env.MODE || 'orderer'
const shareFileDir = process.env.SHARE_FILE_DIR || './crypto/' //Make it /etc/hyperledger during deployment

if(mode === 'orderer') {
  if(!fs.existsSync(shareFileDir)) {
    const cryptoConfigYaml = `
    OrdererOrgs:
    - Name: ${orgName}
      Domain: orderer.${orgName.toLowerCase()}.com
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
      - &${orgName}Orderer 
        Name: ${orgName}Orderer
        ID: ${orgName}Orderer
        MSPDir: crypto-config/ordererOrganizations/orderer.${orgName.toLowerCase()}.com/msp
      - &${orgName}
        Name: ${orgName}
        ID: ${orgName}
        MSPDir: crypto-config/peerOrganizations/peer.${orgName.toLowerCase()}.com/msp

    Profiles:
      OneOrgGenesis:
        Orderer:
          OrdererType: solo
          Addresses:
              - orderer.${orgName.toLowerCase()}.com:7050
          BatchTimeout: 2s
          BatchSize:
              MaxMessageCount: 10
              AbsoluteMaxBytes: 98 MB
              PreferredMaxBytes: 512 KB
          Organizations:
            - *${orgName}Orderer
        Consortiums:
          SingleMemberConsortium:
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
    shell.exec('FABRIC_CFG_PATH=$PWD configtxgen -profile OneOrgGenesis -outputBlock ./genesis.block')

    let files = fs.readdirSync('crypto-config/peerOrganizations/peer.blockcluster.com/ca/')
    files.forEach(fileName => {

      if(fileName.indexOf('_sk') > -1) {
        shell.exec(`mv crypto-config/peerOrganizations/peer.blockcluster.com/ca/${fileName} crypto-config/peerOrganizations/peer.blockcluster.com/ca/privateKey`)
      }
    })
  }
}