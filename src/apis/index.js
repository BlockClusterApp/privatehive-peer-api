const app = require('express')()
const fs = require('fs')
const toPascalCase = require('to-pascal-case')
const shell = require('shelljs')
const yamlJs = require('json2yaml')
const jsYaml = require('js-yaml');
const hfc = require('fabric-client');
const bodyParser = require('body-parser')
const sleep = require('sleep-async')().Promise;
const Unzipper = require("decompress-zip");
const multer   = require("multer");
const path     = require("path");

const shareFileDir = process.env.SHARE_FILE_DIR || './crypto' 
const orgName = toPascalCase(process.env.ORG_NAME)

app.use(bodyParser.json())
app.use(multer({dest:`${shareFileDir}/uploads/`}).single('chaincode_zip'));

shell.mkdir('-p', `${shareFileDir}/uploads/`)

app.get('/channelConfigCerts', (req, res) => {
  let result = {}

  result.adminCert = fs.readFileSync(`${shareFileDir}/crypto-config/peerOrganizations/peer.${orgName.toLowerCase()}.com/msp/admincerts/Admin@peer.${orgName.toLowerCase()}.com-cert.pem`, "utf8");
  result.caCert = fs.readFileSync(`${shareFileDir}/crypto-config/peerOrganizations/peer.${orgName.toLowerCase()}.com/msp/cacerts/ca.peer.${orgName.toLowerCase()}.com-cert.pem`, "utf8");

  res.send(result)
})

app.get('/orgDetails', (req, res) => {
  let details = fs.readFileSync(shareFileDir + `/${orgName.toLowerCase()}.json`, 'utf8')
  res.send({message: details})
})

app.post('/createChannel', async (req, res) => {
  let channelName = req.body.name.toLowerCase()
  let ordererURL = req.body.ordererURL
  let ordererOrgName = req.body.ordererOrgName.toLowerCase()

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
    fs.writeFileSync(shareFileDir + "/network-map.yaml", networkMap)

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

app.post('/joinChannel', async (req, res) => {
  let channelName = req.body.name.toLowerCase()
  let ordererURL = req.body.ordererURL
  let ordererOrgName = req.body.ordererOrgName.toLowerCase()

  let networkMap = jsYaml.safeLoad(fs.readFileSync(`${shareFileDir}/network-map.yaml`, 'utf8'));

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

    networkMap = yamlJs.stringify(networkMap);
    fs.writeFileSync(shareFileDir + "/network-map.yaml", networkMap)

    hfc.setConfigSetting('network-map', shareFileDir + '/network-map.yaml');
    let client = hfc.loadFromConfig(hfc.getConfigSetting('network-map'));
    await client.initCredentialStores();

    var channel = client.getChannel(channelName);

    let request = {
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
    res.send({error: true, message: 'Channel already joined'})
  }
})

app.post('/addOrgToChannel', async (req, res) => {
  let channelName = req.body.name.toLowerCase()
  let newOrgName = toPascalCase(req.body.newOrgName) 
  let newOrgConf = req.body.newOrgConf

  shell.cd(shareFileDir)
  
  let networkMap = jsYaml.safeLoad(fs.readFileSync(shareFileDir + '/network-map.yaml', 'utf8'));
  let ordererURL = networkMap.orderers[networkMap.channels[channelName].orderers[0]].url

  ordererURL = ordererURL.substring(7)
  
  fs.writeFileSync(`${shareFileDir}/${newOrgName.toLowerCase()}.json`, newOrgConf.toString())

  async function executeCommand(cmd) {
    if (shell.exec(cmd, {shell: '/bin/bash'}).code !== 0) {
      console.log("Failed", cmd)
      return Promise.reject();
    } else {
      return Promise.resolve();
    }
  }

  await executeCommand(`screen -d -m configtxlator start`)
  await sleep.sleep(2000)
  await executeCommand(`peer channel fetch config config_block.pb -o ${ordererURL} -c ${channelName}`)
  await executeCommand('curl -X POST --data-binary @config_block.pb "$CONFIGTXLATOR_URL/protolator/decode/common.Block" | jq . > config_block.json')
  await executeCommand('jq .data.data[0].payload.data.config config_block.json > config.json')
  await executeCommand(`jq -s '.[0] * {"channel_group":{"groups":{"Application":{"groups":{"${newOrgName}":.[1]}}}}}' config.json ./${newOrgName.toLowerCase()}.json >& updated_config.json`)
  await executeCommand(`curl -X POST --data-binary @config.json "$CONFIGTXLATOR_URL/protolator/encode/common.Config" > config.pb`)
  await executeCommand(`curl -X POST --data-binary @updated_config.json "$CONFIGTXLATOR_URL/protolator/encode/common.Config" > updated_config.pb`)
  await executeCommand(`curl -X POST -F channel=${channelName} -F "original=@config.pb" -F "updated=@updated_config.pb" "$CONFIGTXLATOR_URL/configtxlator/compute/update-from-configs" > config_update.pb`)
  await executeCommand(`curl -X POST --data-binary @config_update.pb "$CONFIGTXLATOR_URL/protolator/decode/common.ConfigUpdate" | jq . > config_update.json`)
  await executeCommand(`echo '{"payload":{"header":{"channel_header":{"channel_id":"${channelName}","type":2}},"data":{"config_update":'$(cat config_update.json)'}}}' | jq . > config_update_in_envelope.json`)
  await executeCommand(`curl -X POST --data-binary @config_update_in_envelope.json "$CONFIGTXLATOR_URL/protolator/encode/common.Envelope" > config_update_in_envelope.pb`)
  await executeCommand(`peer channel signconfigtx -f config_update_in_envelope.pb`)
  await executeCommand(`peer channel update -f config_update_in_envelope.pb -c ${channelName} -o ${ordererURL}`)
  await executeCommand(`screen -ls | grep Detached | cut -d. -f1 | awk '{print $1}' | xargs kill`)

  console.log("Success in running commands")

  res.send({message: 'Added new org to the channel'})
})

app.post('/chaincodes/add', async (req, res) => {
  let chaincodeName = req.body.chaincodeName.toLowerCase();
  let chaincodeLanguage = req.body.chaincodeLanguage;

  if(req.file) {
    let filepath = path.join(req.file.destination, req.file.filename);
    let unzipper = new Unzipper(filepath);

    let moveFiles = (dir1, dir2) => {
      return new Promise((resolve, reject) => {
        mv(dir1, dir2, (err) => {
          if(err) {
            reject()
          } else {
            resolve()
          }
        })
      })
    }

    shell.mkdir('-p', `${shareFileDir}/src/github.com/${chaincodeName}/1.0/${chaincodeLanguage}/`)
    unzipper.extract({ path: `${shareFileDir}/src/github.com/${chaincodeName}/1.0/${chaincodeLanguage}/` });


    let folderName = fs.readdirSync(`${shareFileDir}/src/github.com/${chaincodeName}/1.0/${chaincodeLanguage}/`)[0]
    await moveFiles(`${shareFileDir}/src/github.com/${chaincodeName}/1.0/${chaincodeLanguage}/${folderName}/`, `${shareFileDir}/src/github.com/${chaincodeName}/1.0/${chaincodeLanguage}/`)
    shell.exec(`rm -rf ${shareFileDir}/src/github.com/${chaincodeName}/1.0/${chaincodeLanguage}/${folderName}`)

    res.send({message: 'Chaincode added successfully'})
  } else {
    res.send({error: true, message: 'Chaincode missing'})
  }
})

app.get('/chaincodes/list', async (req, res) => {
  let chaincodes = []
  
  fs.readdirSync(`${shareFileDir}/src/github.com/`).forEach((name) => {
    let version = fs.readdirSync(`${shareFileDir}/src/github.com/${name}/`)[0];
    chaincodes.push({
      name,
      version,
      language: fs.readdirSync(`${shareFileDir}/src/github.com/${name}/${version}/`)[0]
    })
  })

  res.send({
    message: chaincodes
  })
})

app.get('/chaincodes/install', async (req, res) => {
  let chaincodeName = req.body.chaincodeName.toLowerCase()
  let language = req.body.chaincodeLanguage
  let version = fs.readdirSync(`${shareFileDir}/src/github.com/${chaincodeName}/`)[0]
  let langauge = fs.readdirSync(`${shareFileDir}/src/github.com/${chaincodeName}/${version}/`)[0]

  hfc.setConfigSetting('network-map', shareFileDir + "/network-map.yaml");
  let client = hfc.loadFromConfig(hfc.getConfigSetting('network-map'));
  await client.initCredentialStores();
  await client.setUserContext({username: "admin", password: "adminpw"});

  let request = {
    targets: [`peer0.peer.${orgName.toLowerCase()}.com`],
    chaincodePath: `${shareFileDir}/src/github.com/${chaincodeName}/${version}/${langauge}`,
    chaincodeId: chaincodeName,
    chaincodeVersion: version,
    chaincodeType: langauge
  };

  let results = await client.installChaincode(request);
  let proposalResponses = results[0];
  let proposal = results[1];
  
  let all_good = true;
  for (let i in proposalResponses) {
    let one_good = false;
    if (proposalResponses && proposalResponses[i].response &&
      proposalResponses[i].response.status === 200) {
      one_good = true;
    }
    all_good = all_good & one_good;
  }
  if (!all_good) {
    error_message = 'Failed to send install Proposal or receive valid response. Response null or status is not 200'
  }

  if (!error_message) {
		res.send({message: 'Chaincode installed successfully'})
	} else {
    res.send({error: true, message: `Failed to install chaincode: ${error_message}`})
	}
})

app.listen(3000, () => console.log('API Server Running'))