const app = require('express')()
const fs = require('fs')
const toPascalCase = require('to-pascal-case')
const shell = require('shelljs')
var yamlJs = require('json2yaml')
const jsYaml = require('js-yaml');
let hfc = require('fabric-client');
let bodyParser = require('body-parser')

const shareFileDir = process.env.SHARE_FILE_DIR || './crypto' 
const orgName = toPascalCase(process.env.ORG_NAME)

app.use(bodyParser.json())

app.get('/channelConfigCerts', (req, res) => {
  let result = {}

  result.adminCert = fs.readFileSync(`${shareFileDir}/crypto-config/peerOrganizations/peer.${orgName.toLowerCase()}.com/msp/admincerts/Admin@peer.${orgName.toLowerCase()}.com-cert.pem`, "utf8");
  result.caCert = fs.readFileSync(`${shareFileDir}/crypto-config/peerOrganizations/peer.${orgName.toLowerCase()}.com/msp/cacerts/ca.peer.${orgName.toLowerCase()}.com-cert.pem`, "utf8");

  res.send(result)
})

app.post('/createChannel', async (req, res) => {
  let channelName = req.body.name.toLowerCase()
  let ordererURL = req.body.ordererURL
  let ordererOrgName = req.body.ordererOrgName

  shell.cd(shareFileDir)
  shell.exec(`FABRIC_CFG_PATH=$PWD configtxgen -profile OneOrgChannel -outputCreateChannelTx ./${channelName}.tx -channelID ${channelName}`)

  let networkMap = jsYaml.safeLoad(fs.readFileSync('./network-map.yaml', 'utf8'));

  if(!networkMap.channels[channelName]) {
    networkMap.channels[channelName] = {
      "orderers": [
        `orderer.${ordererOrgName}.com`
      ],
      "peers": {}
    }

    networkMap.orderers[`orderer.${ordererOrgName}.com`] = {
      "url": `grpc://${ordererURL}`
    }

    networkMap.channels[channelName].peers[`peer0.peer.${orgName.toLowerCase()}.com`] = {
      "chaincodeQuery": true,
      "ledgerQuery": true,
      "eventSource": true
    }

    networkMap.channels[channelName].chaincodes = ["mycc:v0"]

    networkMap = yamlJs.stringify(networkMap);
    fs.writeFileSync('./network-map.yaml', networkMap)

    //create the channel now
    hfc.setConfigSetting('network-map', shareFileDir + "/network-map.yaml");
    let client = hfc.loadFromConfig(hfc.getConfigSetting('network-map'));
    await client.initCredentialStores();
    let envelope = fs.readFileSync(`${shareFileDir}/${channelName}.tx`);
    let channelConfig = client.extractChannelConfig(envelope);
    let signature = client.signChannelConfig(channelConfig);
    let request = {
      config: channelConfig,
      signatures: [signature],
      name: channelName,
      txId: client.newTransactionID(true)
    };
    
    var response = await client.createChannel(request)

    if (response && response.status === 'SUCCESS') {
      //res.send({message: 'Channel created successfully'})
      hfc.setConfigSetting('network-map', shareFileDir + "/network-map.yaml");
      client = hfc.loadFromConfig(hfc.getConfigSetting('network-map'));
      await client.initCredentialStores();
      let channel = client.getChannel(channelName);
      request = {
        txId : 	client.newTransactionID(true) 
      };
      let genesis_block = await channel.getGenesisBlock(request);

      let join_request = {
        targets: [`peer0.peer.${orgName.toLowerCase()}.com`],
        txId: client.newTransactionID(true),
        block: genesis_block
      };

      let result = await channel.joinChannel(join_request);

      if(result.response) {
        if(result.response.status == 200) {
          res.send({message: 'Created and joined channel'})
        } else {
          res.send({error: true, message: 'An error occured'})
        }
      } else {
        res.send({error: true, message: 'An error occured'})
      }
		} else {
      res.send({error: true, message: 'Failed to create channel'})
		}
  } else {
    res.send({error: true, message: 'Channel already exists'})
  }
})

app.listen(3000, () => console.log('API Server Running'))