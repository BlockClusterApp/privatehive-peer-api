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
const atob = require('atob');
const low = require('lowdb')
const FileSync = require('lowdb/adapters/FileSync')
const request = require('request');
const getSize = require('get-folder-size');
const zip = require('node-zip-dir');

const shareFileDir = process.env.SHARE_FILE_DIR || './crypto' 
const orgName = toPascalCase(process.env.ORG_NAME)
const workerNodeIP = process.env.WORKER_NODE_IP || '127.0.0.1'
const anchorPort = process.env.ANCHOR_PORT || 7051

app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }));
app.use(multer({dest:`${shareFileDir}/uploads/`}).single('chaincode_zip'));

shell.mkdir('-p', `${shareFileDir}/uploads/`)

const notifications_adapter = new FileSync(`${shareFileDir}/notifications.json`)
const notifications_db = low(notifications_adapter)
notifications_db.defaults({ notifications: [] }).write()

async function executeCommand(cmd) {
  if (shell.exec(cmd, {shell: '/bin/bash'}).code !== 0) {
    console.log("Failed", cmd)
    return Promise.reject();
  } else {
    return Promise.resolve();
  }
}

app.get('/config/ordererCerts', (req, res) => {
  let result = {
    message: {}
  }

  result.message.adminCert = fs.readFileSync(`${shareFileDir}/crypto-config/peerOrganizations/peer.${orgName.toLowerCase()}.com/msp/admincerts/Admin@peer.${orgName.toLowerCase()}.com-cert.pem`, "utf8");
  result.message.caCert = fs.readFileSync(`${shareFileDir}/crypto-config/peerOrganizations/peer.${orgName.toLowerCase()}.com/msp/cacerts/ca.peer.${orgName.toLowerCase()}.com-cert.pem`, "utf8");

  res.send(result)
})

app.get('/config/orgDetails', (req, res) => {
  let details = fs.readFileSync(shareFileDir + `/${orgName.toLowerCase()}.json`, 'utf8')
  res.send({message: details})
})

app.get('/config/connectionProfile', (req, res) => {
  let details = fs.readFileSync(shareFileDir + `/network-map.yaml`, 'utf8')
  res.send({message: details})
})

app.get('/config/cryptoConfig', async (req, res) => {

  shell.exec(`mkdir -p ${shareFileDir}/downloads/cryptoConfig/crypto-config/`)
  shell.exec(`cp -a ${shareFileDir}/crypto-config/. ${shareFileDir}/downloads/cryptoConfig/crypto-config/`)

  let dirPath = `${shareFileDir}/downloads/cryptoConfig/`;
  await zip.zip(dirPath, shareFileDir + '/crypto-config.zip')
  res.download(shareFileDir + '/crypto-config.zip');
})


app.post('/channel/create', async (req, res) => {
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

      await sleep.sleep(5000)

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


      if(result[0].response) {
        if(result[0].response.status == 200) {

          //update anchor peer
          await executeCommand(`FABRIC_CFG_PATH=$PWD configtxgen -profile OneOrgChannel -outputAnchorPeersUpdate ./${orgName}_${channelName}_AnchorUpdate.tx -channelID ${channelName} -asOrg ${orgName}`)
          await executeCommand(`peer channel update -o ${ordererURL} -c ${channelName} -f ./${orgName}_${channelName}_AnchorUpdate.tx`)

          res.send({message: 'Created and joined channel'})
        } else {
          res.send({error: true, message: 'An error occured'})
        }
      } else {
        res.send({error: true, message: 'An error occured'})
      }
		} else {
      console.log(response)
      res.send({error: true, message: 'Failed to create channel'})
		}
  } else {
    res.send({error: true, message: 'Channel already exists'})
  }
})

app.post('/channel/join', async (req, res) => {
  let channelName = req.body.name.toLowerCase()
  let ordererURL = req.body.ordererURL
  let ordererOrgName = req.body.ordererOrgName.toLowerCase()

  shell.cd(shareFileDir)

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

    if(result[0].response) {
      if(result[0].response.status == 200) {
        try {
          await executeCommand(`screen -d -m configtxlator start`)
          await sleep.sleep(2000)
          await executeCommand(`peer channel fetch config config_block.pb -o ${ordererURL} -c ${channelName} `)
          await executeCommand(`configtxlator proto_decode --input config_block.pb --type common.Block | jq .data.data[0].payload.data.config > config.json`)
          await executeCommand(`jq '.channel_group.groups.Application.groups.${orgName}.values.AnchorPeers={"mod_policy": "Admins", "value": {"anchor_peers": [{"host": "${workerNodeIP}", "port": ${anchorPort}}]},"version": "0"}' config.json > modified_config.json`)
          await executeCommand(`configtxlator proto_encode --input config.json --type common.Config --output config.pb`)
          await executeCommand(`configtxlator proto_encode --input modified_config.json --type common.Config --output modified_config.pb`)
          await executeCommand(`configtxlator compute_update --channel_id ${channelName} --original config.pb --updated modified_config.pb --output ${orgName.toLowerCase()}_update.pb`)
          await executeCommand(`configtxlator proto_decode --input ${orgName.toLowerCase()}_update.pb --type common.ConfigUpdate | jq . > ${orgName.toLowerCase()}_update.json`)
          await executeCommand(`echo '{"payload":{"header":{"channel_header":{"channel_id":"${channelName}", "type":2}},"data":{"config_update":'$(cat ${orgName.toLowerCase()}_update.json)'}}}' | jq . > ${orgName.toLowerCase()}_update_in_envelope.json`)
          await executeCommand(`configtxlator proto_encode --input ${orgName.toLowerCase()}_update_in_envelope.json --type common.Envelope --output ${orgName.toLowerCase()}_update_in_envelope.pb`)
          await executeCommand(`peer channel signconfigtx -f ${orgName.toLowerCase()}_update_in_envelope.pb`)
          await executeCommand(`peer channel update -f ${orgName.toLowerCase()}_update_in_envelope.pb -c ${channelName} -o  ${ordererURL}`)
          await executeCommand(`rm config_block.pb config.json modified_config.json config.pb modified_config.pb ${orgName.toLowerCase()}_update.pb ${orgName.toLowerCase()}_update.json ${orgName.toLowerCase()}_update_in_envelope.json ${orgName.toLowerCase()}_update_in_envelope.pb`)
          await executeCommand(`screen -ls | grep Detached | cut -d. -f1 | awk '{print $1}' | xargs kill`)

          res.send({message: 'Created and joined channel'})
        } catch (e) {
          console.log(e)
          res.send({error: true, message: e})
        }
        
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

app.post('/channel/addOrg', async (req, res) => {
  let channelName = req.body.name.toLowerCase()
  let newOrgName = toPascalCase(req.body.newOrgName) 
  let newOrgConf = req.body.newOrgConf

  try {
    shell.cd(shareFileDir)
  
    let networkMap = jsYaml.safeLoad(fs.readFileSync(shareFileDir + '/network-map.yaml', 'utf8'));
    let ordererURL = networkMap.orderers[networkMap.channels[channelName].orderers[0]].url

    ordererURL = ordererURL.substring(7)
    
    fs.writeFileSync(`${shareFileDir}/${newOrgName.toLowerCase()}.json`, newOrgConf.toString())

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
    await executeCommand(`rm config_block.json config.json updated_config.json config.pb updated_config.pb config_update.pb config_update.json config_update_in_envelope.json`)
    await executeCommand(`screen -ls | grep Detached | cut -d. -f1 | awk '{print $1}' | xargs kill`)

    console.log("Success in running commands")

    res.send({message: 'Added new org to the channel'})
  } catch(e) {
    res.send({error: true, message: e.toString()})
  }
})

app.get('/channels/list', async (req, res) => {
  let channels = []

  shell.cd(shareFileDir)
  let networkMap = jsYaml.safeLoad(fs.readFileSync('./network-map.yaml', 'utf8'));

  if(networkMap.channels) {
    for(let channelName in networkMap.channels) {
      let connectionDetails = networkMap.orderers[networkMap.channels[channelName].orderers[0]].url
      let ordererDomain = networkMap.channels[channelName].orderers[0]
      channels.push({
        name: channelName,
        ordererDomain,
        connectionDetails
      })
    }
  }

  res.send({
    message: channels
  })
})

app.post('/chaincodes/add', async (req, res) => {
  let chaincodeName = req.body.chaincodeName.toLowerCase();
  let chaincodeLanguage = req.body.chaincodeLanguage;

  if (!fs.existsSync(`${shareFileDir}/chaincodes/${chaincodeName}`)) {
    if(req.file) {
      let filepath = path.join(req.file.destination, req.file.filename);
      let unzipper = new Unzipper(filepath);
  
      shell.mkdir('-p', `${shareFileDir}/chaincodes/${chaincodeName}/1.0/${chaincodeLanguage}/`)
      unzipper.extract({ path:  `${shareFileDir}/chaincodes/${chaincodeName}/1.0/${chaincodeLanguage}/`});
  
      setTimeout(() => {
        let folderName = chaincodeName
        if (fs.existsSync(`${shareFileDir}/chaincodes/${chaincodeName}/1.0/${chaincodeLanguage}/${folderName}`)) {
          shell.exec(`mv ${shareFileDir}/chaincodes/${chaincodeName}/1.0/${chaincodeLanguage}/${folderName}/* ${shareFileDir}/chaincodes/${chaincodeName}/1.0/${chaincodeLanguage}/`)
          shell.exec(`rm -rf ${shareFileDir}/chaincodes/${chaincodeName}/1.0/${chaincodeLanguage}/${folderName}`)  
          res.send({message: 'Chaincode added successfully'})
        } else {
          shell.exec(`rm -rf ${shareFileDir}/chaincodes/${chaincodeName}`)
          res.send({error: true, message: 'Chaincode directory name wrong'})
        }
      }, 3000)
    } else {
      res.send({error: true, message: 'Chaincode missing'})
    }    
  } else {
    res.send({error: true, message: 'Chaincode already exists'})
  }
})

app.get('/chaincodes/list', async (req, res) => {
  let chaincodes = []
  
  fs.readdirSync(`${shareFileDir}/chaincodes/`).forEach((name) => {
    let version = fs.readdirSync(`${shareFileDir}/chaincodes/${name}/`)[0];
    chaincodes.push({
      name,
      version,
      language: fs.readdirSync(`${shareFileDir}/chaincodes/${name}/${version}/`)[0]
    })
  })

  res.send({
    message: chaincodes
  })
})

app.post('/chaincodes/install', async (req, res) => {
  let chaincodeName = req.body.chaincodeName
  let version = fs.readdirSync(`${shareFileDir}/chaincodes/${chaincodeName}/`)[0]
  let langauge = fs.readdirSync(`${shareFileDir}/chaincodes/${chaincodeName}/${version}/`)[0]

  shell.cd(shareFileDir)

  hfc.setConfigSetting('network-map', shareFileDir + "/network-map.yaml");
  let client = hfc.loadFromConfig(hfc.getConfigSetting('network-map'));
  await client.initCredentialStores();
  await client.setUserContext({username: "admin", password: "adminpw"});

  if(langauge === 'golang') {
    shell.exec(`mkdir -p /opt/gopath/src/chaincodes/${chaincodeName}/${version}`)
    shell.exec(`ln -s ${shareFileDir}/chaincodes/${chaincodeName}/${version}/${langauge}/* /opt/gopath/src/chaincodes/${chaincodeName}/${version}/`) 
  }

  let chaincodePath = null;

  if(langauge === 'golang') {
    chaincodePath = `chaincodes/${chaincodeName}/${version}`
  } else {
    chaincodePath = `${shareFileDir}/chaincodes/${chaincodeName}/${version}/${langauge}`
  }

  /* Place indexes in META-INF/statedb/couchdb/indexes. For private collections: META-INF/statedb/couchdb/collections/<collection_name>/indexes */

  if(langauge === 'golang') {
    //for golang some sort of extra steps are required for installing chaincode.....otherwise not found module error is thrown. 
    //peer install command does those automatically.
    await executeCommand(`peer chaincode install -n ${chaincodeName} -p ${chaincodePath} -v ${version} -l golang`)
    res.send({message: 'Chaincode installed successfully'})
  } else {

    let indexesExist = fs.existsSync(`${chaincodePath}/META-INF`)

    let request = {
      targets: [`peer0.peer.${orgName.toLowerCase()}.com`],
      chaincodePath,
      chaincodeId: chaincodeName,
      chaincodeVersion: version,
      chaincodeType: langauge
    };

    if(indexesExist) {
      request.metadataPath = `${chaincodePath}/META-INF`
    }
  
    let results = await client.installChaincode(request);
    let proposalResponses = results[0];
    let error_message = null;
    
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
  }
})

app.post('/chaincodes/instantiate', async (req, res) => {
  let chaincodeName = req.body.chaincodeName
  let channelName = req.body.channelName
  let fcn = req.body.fcn || null
  let args = req.body.args
  let endorsmentPolicy = req.body.endorsmentPolicy || {
    identities: [
      { role: { name: 'member', mspId: orgName }},
    ],
    policy: {
      '1-of':[{ 'signed-by': 0 }]
    }
  }

  let collectionsConfig = req.body.collectionsConfig || ''

  shell.cd(shareFileDir)

  hfc.setConfigSetting('network-map', shareFileDir + "/network-map.yaml");
  let client = hfc.loadFromConfig(hfc.getConfigSetting('network-map'));
  
  let error_message = null;

  try {
    await client.initCredentialStores();
    await client.setUserContext({username: "admin", password: "adminpw"});

    let channel = client.getChannel(channelName);

    let version = fs.readdirSync(`${shareFileDir}/chaincodes/${chaincodeName}/`)[0]
    let langauge = fs.readdirSync(`${shareFileDir}/chaincodes/${chaincodeName}/${version}/`)[0]
    let tx_id = client.newTransactionID(true);
    let deployId = tx_id.getTransactionID();


    let request = {
      targets: [`peer0.peer.${orgName.toLowerCase()}.com`],
      chaincodeId: chaincodeName,
      chaincodeType: langauge,
      chaincodeVersion: version,
      txId: tx_id,
      'endorsement-policy': endorsmentPolicy
    }

    if(fcn) {
      request.fcn = fcn;
    }
    
    if(args) {
      request.args = args
    }
    
    if(collectionsConfig) {
      fs.writeFileSync(`${shareFileDir}/chaincodes/${chaincodeName}/${version}/${langauge}/collections-config.json`, JSON.stringify(collectionsConfig) , 'utf-8'); 
      request['collections-config'] = `${shareFileDir}/chaincodes/${chaincodeName}/${version}/${langauge}/collections-config.json`
    }  

    let results = await channel.sendInstantiateProposal(request, 90000);

    let proposalResponses = results[0];
    let proposal = results[1];
    let all_good = true;

    for (var i in proposalResponses) {
      let one_good = false;
      if (proposalResponses && proposalResponses[i].response &&
        proposalResponses[i].response.status === 200) {
        one_good = true;
      }
      all_good = all_good & one_good;
    }

    if (all_good) {
      let promises = [];
      let event_hubs = channel.getChannelEventHubsForOrg();

      event_hubs.forEach((eh) => {
        let instantiateEventPromise = new Promise((resolve, reject) => {
          let event_timeout = setTimeout(() => {
            let message = 'REQUEST_TIMEOUT:' + eh.getPeerAddr();
            eh.disconnect();
          }, 60000);
          eh.registerTxEvent(deployId, (tx, code, block_num) => {
            clearTimeout(event_timeout);

            if (code !== 'VALID') {
              let message = `The chaincode instantiate transaction was invalid, code: ${code}`
              reject(new Error(message));
            } else {
              let message = 'The chaincode instantiate transaction was valid.';
              resolve(message);
            }
          }, (err) => {
            clearTimeout(event_timeout);
            console.log(err);
            reject(err);
          },
            {unregister: true, disconnect: true}
          );
          eh.connect();
        });
        promises.push(instantiateEventPromise);
      });

      let orderer_request = {
        txId: tx_id,
        proposalResponses: proposalResponses,
        proposal: proposal
      };

      let sendPromise = channel.sendTransaction(orderer_request);
      promises.push(sendPromise);
      let results = await Promise.all(promises);

      let response = results.pop(); //  orderer results are last in the results
      if (response.status !== 'SUCCESS') {
        error_message = `Failed to order the transaction. Error code: ${response.status}` 
      }

      for(let i in results) {
        let event_hub_result = results[i];
        let event_hub = event_hubs[i];
        if(typeof event_hub_result === 'string') {
        } else {
          if(!error_message) error_message = event_hub_result.toString();
        }
      }
    } else {
      error_message = `Failed to send Proposal and receive all good ProposalResponse`
    }
  } catch(error){
		error_message = error.toString();
  }

  if (!error_message) {
		let message = `Successfully instantiate chaincode in organization ${orgName} to the channel ${channelName}` 
    res.send({message})
	} else {
		let message = `Failed to instantiate. cause: ${error_message}`
    res.send({error: true, message})
  }
})

app.post('/chaincodes/upgrade', async (req, res) => {
  let chaincodeName = req.body.chaincodeName
  let channelName = req.body.channelName
  let fcn = req.body.fcn || null
  let args = req.body.args
  let chaincodeVersion = req.body.chaincodeVersion
  let endorsmentPolicy = req.body.endorsmentPolicy || `{
    "identities": [
      { "role": { "name": "member", "mspId": "${orgName}" }}
    ],
    "policy": {
      "1-of":[{ "signed-by": 0 }]
    }
  }`

  let collectionsConfig = req.body.collectionsConfig || ''

  try {
    args = JSON.parse(args)
  } catch(e) {
    res.send({error: true, message: `Args should be JSON string`})
    return;
  }

  try {
    endorsmentPolicy = JSON.parse(endorsmentPolicy)
  } catch(e) {
    res.send({error: true, message: `Endorsement should be valid JSON`})
    return;
  }

  shell.cd(shareFileDir)

  //1. Upload chaincode
  if (fs.existsSync(`${shareFileDir}/chaincodes/${chaincodeName}`)) {
    if(req.file) {
      let filepath = path.join(req.file.destination, req.file.filename);
      let unzipper = new Unzipper(filepath);

      let currentVersion = fs.readdirSync(`${shareFileDir}/chaincodes/${chaincodeName}/`)[0]
      let chaincodeLanguage = fs.readdirSync(`${shareFileDir}/chaincodes/${chaincodeName}/${currentVersion}/`)[0]

      if(currentVersion === chaincodeVersion) {
        res.send({error: true, message: `Version already exists`})
        return;
      }

      shell.mkdir('-p', `${shareFileDir}/chaincodes/${chaincodeName}/${chaincodeVersion}/${chaincodeLanguage}/`)
      unzipper.extract({ path:  `${shareFileDir}/chaincodes/${chaincodeName}/${chaincodeVersion}/${chaincodeLanguage}/`});
  
      setTimeout(async () => {
        let folderName = chaincodeName
        if (fs.existsSync(`${shareFileDir}/chaincodes/${chaincodeName}/${chaincodeVersion}/${chaincodeLanguage}/${folderName}`)) {
          shell.exec(`rm -rf ${shareFileDir}/chaincodes/${chaincodeName}/${currentVersion}`)  
          shell.exec(`mv ${shareFileDir}/chaincodes/${chaincodeName}/${chaincodeVersion}/${chaincodeLanguage}/${folderName}/* ${shareFileDir}/chaincodes/${chaincodeName}/${chaincodeVersion}/${chaincodeLanguage}/`)
          shell.exec(`rm -rf ${shareFileDir}/chaincodes/${chaincodeName}/${chaincodeVersion}/${chaincodeLanguage}/${folderName}`)  
          
          //2. Install chaincode
          hfc.setConfigSetting('network-map', shareFileDir + "/network-map.yaml");
          let client = hfc.loadFromConfig(hfc.getConfigSetting('network-map'));
          await client.initCredentialStores();
          await client.setUserContext({username: "admin", password: "adminpw"});

          if(chaincodeLanguage === 'golang') {
            shell.exec(`mkdir -p /opt/gopath/src/chaincodes/${chaincodeName}/${chaincodeVersion}`)
            shell.exec(`ln -s ${shareFileDir}/chaincodes/${chaincodeName}/${chaincodeVersion}/${chaincodeLanguage}/* /opt/gopath/src/chaincodes/${chaincodeName}/${chaincodeVersion}/`)
            
            let chaincodePath = null;

            if(chaincodeLanguage === 'golang') {
              chaincodePath = `chaincodes/${chaincodeName}/${chaincodeVersion}`
            } else {
              chaincodePath = `${shareFileDir}/chaincodes/${chaincodeName}/${chaincodeVersion}/${chaincodeLanguage}`
            }

            let error_message = null;

            if(chaincodeLanguage === 'golang') {
              await executeCommand(`peer chaincode install -n ${chaincodeName} -p ${chaincodePath} -v ${chaincodeVersion} -l golang`)
            } else {
              let request = {
                targets: [`peer0.peer.${orgName.toLowerCase()}.com`],
                chaincodePath,
                chaincodeId: chaincodeName,
                chaincodeVersion: chaincodeVersion,
                chaincodeType: chaincodeLanguage
              };

              let results = await client.installChaincode(request);
              let proposalResponses = results[0];
              

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
                await sleep.sleep(3000)
              } else {
                res.send({error: true, message: `Failed to install chaincode: ${error_message}`})
                return;
              }
            }

            //3. Now upgrade chaincode
            try {
              let channel = client.getChannel(channelName);
              let tx_id = client.newTransactionID(true);
              let deployId = tx_id.getTransactionID();

              let request = {
                targets: [`peer0.peer.${orgName.toLowerCase()}.com`],
                chaincodeId: chaincodeName,
                chaincodeType: chaincodeLanguage,
                chaincodeVersion: chaincodeVersion,
                txId: tx_id,
                'endorsement-policy': endorsmentPolicy
              }

              if(fcn)
                request.fcn = fcn;
                  
              if(args)
                request.args = args

              if(collectionsConfig) {
                collectionsConfig = JSON.parse(collectionsConfig)
                fs.writeFileSync(`${shareFileDir}/chaincodes/${chaincodeName}/${chaincodeVersion}/${chaincodeLanguage}/collections-config.json`, JSON.stringify(collectionsConfig) , 'utf-8'); 
                request['collections-config'] = `${shareFileDir}/chaincodes/${chaincodeName}/${chaincodeVersion}/${chaincodeLanguage}/collections-config.json`
              }

              let results = await channel.sendUpgradeProposal(request, 90000);
              let proposalResponses = results[0];
              let proposal = results[1];
              let all_good = true;

              for (var i in proposalResponses) {
                let one_good = false;
                if (proposalResponses && proposalResponses[i].response &&
                  proposalResponses[i].response.status === 200) {
                  one_good = true;
                }
                all_good = all_good & one_good;
              }
              
              if (all_good) {
                let promises = [];
                let event_hubs = channel.getChannelEventHubsForOrg();
          
                event_hubs.forEach((eh) => {
                  let upgradeEventPromise = new Promise((resolve, reject) => {
                    let event_timeout = setTimeout(() => {
                      let message = 'REQUEST_TIMEOUT:' + eh.getPeerAddr();
                      eh.disconnect();
                    }, 60000);
                    eh.registerTxEvent(deployId, (tx, code, block_num) => {
                      clearTimeout(event_timeout);
          
                      if (code !== 'VALID') {
                        let message = `The chaincode upgrade transaction was invalid, code: ${code}`
                        reject(new Error(message));
                      } else {
                        let message = 'The chaincode upgrade transaction was valid.';
                        resolve(message);
                      }
                    }, (err) => {
                      clearTimeout(event_timeout);
                      console.log(err);
                      reject(err);
                    },
                      {unregister: true, disconnect: true}
                    );
                    eh.connect();
                  });
                  promises.push(upgradeEventPromise);
                });
          
                let orderer_request = {
                  txId: tx_id,
                  proposalResponses: proposalResponses,
                  proposal: proposal
                };
          
                let sendPromise = channel.sendTransaction(orderer_request);
                promises.push(sendPromise);
                let results = await Promise.all(promises);
          
                let response = results.pop(); //  orderer results are last in the results
                if (response.status !== 'SUCCESS') {
                  error_message = `Failed to order the transaction. Error code: ${response.status}` 
                }
          
                for(let i in results) {
                  let event_hub_result = results[i];
                  let event_hub = event_hubs[i];
                  if(typeof event_hub_result === 'string') {
                  } else {
                    if(!error_message) error_message = event_hub_result.toString();
                  }
                }
              } else {
                error_message = `Failed to send Proposal and receive all good ProposalResponse`
              }
            } catch(error) {
              error_message = error.toString();
            }

            if (!error_message) {
              let message = `Successfully upgraded chaincode in organization ${orgName} to the channel ${channelName}` 
              res.send({message})
            } else {
              let message = `Failed to upgrade. cause: ${error_message}`
              res.send({error: true, message})
            }
          }
        } else {
          shell.exec(`rm -rf ${shareFileDir}/chaincodes/${chaincodeName}`)
          res.send({error: true, message: 'Chaincode directory name wrong'})
        }
      }, 3000)
    } else {
      res.send({error: true, message: 'Chaincode missing'})
    }    
  } else {
    res.send({error: true, message: 'Chaincode doesn\'t exist' })
  }
})

app.post('/chaincodes/invoke', async (req, res) => {
  let error_message = null;
  let tx_id_string = null;
  
  shell.cd(shareFileDir)

  let channelName = req.body.channelName
  let chaincodeName = req.body.chaincodeName
  let fcn = req.body.fcn || ''
  let args = req.body.args

  try {
    args.unshift(fcn)
    await executeCommand(`peer chaincode invoke -C ${channelName} -n ${chaincodeName} -c '{"Args":${JSON.stringify(args)}}'`)
    res.send({message: 'Invoked successfully'})
    return;

    /* JS code works fine but the issue is we have to calculate the targets for endorsement manually using endorsment policy and collections config policies. peer invoke does this for us */
    /*
    hfc.setConfigSetting('network-map', shareFileDir + '/network-map.yaml');
    let client = hfc.loadFromConfig(hfc.getConfigSetting('network-map'));
    await client.initCredentialStores();
    await client.setUserContext({username: "admin", password: "adminpw"});
  
    let channel = client.getChannel(channelName);
  
    var tx_id = client.newTransactionID();
    tx_id_string = tx_id.getTransactionID();

    let targets = [];

    let networkMap = jsYaml.safeLoad(fs.readFileSync('./network-map.yaml', 'utf8'));

    for(let peerDomain in networkMap.channels[channelName].peers) {
      if(networkMap.peers[peerDomain].chaincodes.includes(chaincodeName)) {
        targets.push(peerDomain)
      }
    }

    channel.initialize({
      discover: true,
      target: `peer0.peer.${orgName.toLowerCase()}.com`,
      asLocalhost: false
    })

    let collections = []


    try {
      let collectionsQuery = await channel.queryCollectionsConfig({
        chaincodeId: chaincodeName,
        target: `peer0.peer.${orgName.toLowerCase()}.com`
      })

      collectionsQuery.forEach((collection) => {  
        collections.push(collection.name)
      })
    } catch(e) {
    }

    try {
      let plan = await channel.getEndorsementPlan({
        chaincodes: [{
          name: chaincodeName,
          collection_names: collections
        }]
      })
    } catch(e) {
      res.send({error: true, message: e}); return;
    }
    
    var request = {
      chaincodeId: chaincodeName,
      fcn: fcn,
      args: args,
      chainId: channelName,
      txId: tx_id
    };

    console.log(request)
  
    let results = await channel.sendTransactionProposal(request);
  
    var proposalResponses = results[0];
    var proposal = results[1];
    var all_good = true;

    var all_good = true;
		for (var i in proposalResponses) {
      let one_good = false;
      console.log(proposalResponses[i].response)
			if (proposalResponses && proposalResponses[i].response &&
				proposalResponses[i].response.status === 200) {
				one_good = true;
			}
			all_good = all_good & one_good;
    }
    
    if (all_good) {
			var promises = [];
			let event_hubs = channel.getChannelEventHubsForOrg();
			event_hubs.forEach((eh) => {
				let invokeEventPromise = new Promise((resolve, reject) => {
					let event_timeout = setTimeout(() => {
						let message = 'REQUEST_TIMEOUT:' + eh.getPeerAddr();
						console.log(message);
						eh.disconnect();
					}, 3000);
					eh.registerTxEvent(tx_id_string, (tx, code, block_num) => {
						clearTimeout(event_timeout);
						if (code !== 'VALID') {
							let message = `The invoke chaincode transaction was invalid, code: ${code}` 
							reject(new Error(message));
						} else {
							let message = 'The invoke chaincode transaction was valid.';
							resolve(message);
						}
					}, (err) => {
						clearTimeout(event_timeout);
						reject(err);
					},
            {unregister: true, disconnect: true}
					);
					eh.connect();
				});
				promises.push(invokeEventPromise);
			});

			var orderer_request = {
				txId: tx_id,
				proposalResponses: proposalResponses,
				proposal: proposal
			};
			var sendPromise = channel.sendTransaction(orderer_request);
			promises.push(sendPromise);
			let results = await Promise.all(promises);
			let response = results.pop(); //  orderer results are last in the results
			if (response.status !== 'SUCCESS') {
				error_message = `Failed to order the transaction. Error code: ${response.status}`
			}

			// now see what each of the event hubs reported
			for(let i in results) {
				let event_hub_result = results[i];
				let event_hub = event_hubs[i];
				if(typeof event_hub_result !== 'string') {
          if(!error_message) error_message = event_hub_result.toString();
        }
			}
		} else {
			error_message = 'Failed to send Proposal and receive all good ProposalResponse';
    }
    
    */
  } catch(error) {
    error_message = error;
  }

  if (!error_message) {
		let message = `Successfully invoked the chaincode ${chaincodeName} to the channel ${channelName} for transaction ID: ${tx_id_string}`;
    res.send({message})
	} else {
		let message = `Failed to invoke chaincode. cause: ${error_message}`
    res.send({error: true, message})
	}
})

app.post('/chaincodes/query', async (req, res) => {
  shell.cd(shareFileDir)

  let channelName = req.body.channelName
  let chaincodeName = req.body.chaincodeName
  let args = req.body.args
  let fcn = req.body.fcn

  try { 
    hfc.setConfigSetting('network-map', shareFileDir + '/network-map.yaml');
    let client = hfc.loadFromConfig(hfc.getConfigSetting('network-map'));
    await client.initCredentialStores();
    await client.setUserContext({username: "admin", password: "adminpw"});

    let channel = client.getChannel(channelName);

    if(!channel) {
      res.send({error: true, message: 'Channel not found'})
      return
    }
    
    let request = {
			targets : [`peer0.peer.${orgName.toLowerCase()}.com`], 
			chaincodeId: chaincodeName,
			fcn: fcn,
			args: args
    };
    
    let response_payloads = await channel.queryByChaincode(request);

    if (response_payloads) {
      res.send({message: response_payloads[0].toString('utf8')})
		} else {
      res.send({error: true, message: 'Response was null'})
			return;
		}
  } catch (error) {
    res.send({error: true, message: error.toString()})
  }
})

let notifyClient = async (url, json) => {
  return new Promise((resolve) => {
    request({
      url,
      method: "POST",
      json
    }, (error, result, body) => {
      resolve()
    })
  })
}

const registeredHandlers = {}

let registerNotification = async ({ chaincodeName, channelName, chaincodeEventName, startBlock }) => {
  shell.cd(shareFileDir)
  hfc.setConfigSetting('network-map', shareFileDir + '/network-map.yaml');
  let client = hfc.loadFromConfig(hfc.getConfigSetting('network-map'));
  await client.initCredentialStores();

  let channel = client.getChannel(channelName);
  let eventHub = channel.getChannelEventHubsForOrg(orgName)[0];
  let handler = eventHub.registerChaincodeEvent(chaincodeName, chaincodeEventName,
    async (event, block_num, txnid, status) => {
      let result = notifications_db.get('notifications').find({ chaincodeName, channelName, chaincodeEventName }).value()

      await notifyClient(result.notificationURL, {
        txnId: txnid,
        blockNumber: block_num,
        payload: atob(event.payload.toString('base64'))
      })

      notifications_db.get('notifications').find({ chaincodeName, channelName, chaincodeEventName }).assign({ startBlock: parseInt(block_num)}).write()
    },
    async (error) => {
      let result = notifications_db.get('notifications').find({ chaincodeName, channelName, chaincodeEventName }).value()

      await notifyClient(result.notificationURL, {
        error: true,
        message: error
      })
    },
    {startBlock}
  );

  eventHub.connect(true);

  registeredHandlers[`${channelName}_${chaincodeName}_${chaincodeEventName}`] = { handler, eventHub }

  return Promise.resolve()
}

app.post('/notifications/add', async (req, res) => {
  let chaincodeName = req.body.chaincodeName
  let channelName = req.body.channelName
  let chaincodeEventName = req.body.chaincodeEventName
  let notificationURL = req.body.notificationURL
  let startBlock = req.body.startBlock || 0

  let result = notifications_db.get('notifications').find({
    chaincodeName,
    channelName,
    chaincodeEventName
  }).value()

  if (!result) {
    notifications_db.get('notifications').push({ chaincodeName, channelName, chaincodeEventName, notificationURL, startBlock }).write()
    await registerNotification({ chaincodeName, channelName, chaincodeEventName, startBlock })
    res.send({message: 'Registered successfully'})
  } else {
    res.send({error: true, message: 'Already added notification for this'})
  }
})

app.post('/notifications/update', async (req, res) => {
  let chaincodeName = req.body.chaincodeName
  let channelName = req.body.channelName
  let chaincodeEventName = req.body.chaincodeEventName
  let notificationURL = req.body.notificationURL

  let result = notifications_db.get('notifications').find({
    chaincodeName,
    channelName,
    chaincodeEventName
  }).value()

  if (result) {
    notifications_db.get('notifications').remove({ chaincodeName, channelName, chaincodeEventName }).write()
    notifications_db.get('notifications').push({ chaincodeName, channelName, chaincodeEventName, notificationURL }).write()
    res.send({message: 'Updated successfully'})
  } else {
    res.send({error: true, message: 'Not found'})
  }
})

app.post('/notifications/remove', async (req, res) => {
  let chaincodeName = req.body.chaincodeName
  let channelName = req.body.channelName
  let chaincodeEventName = req.body.chaincodeEventName

  if(registeredHandlers[`${channelName}_${chaincodeName}_${chaincodeEventName}`]) {
    registeredHandlers[`${channelName}_${chaincodeName}_${chaincodeEventName}`].eventHub.unregisterChaincodeEvent(registeredHandlers[`${channelName}_${chaincodeName}_${chaincodeEventName}`].handler, true)
    notifications_db.get('notifications').remove({ chaincodeName, channelName, chaincodeEventName }).write()

    res.send({message: 'Event unregistered and removed'})
  } else {
    res.send({error: true, message: 'Not found'})
  }
})

app.get('/notifications/list', async (req, res) => {
  res.send({
    message: notifications_db.get('notifications').value()
  })
})

let getBlockDetailsByNumber = async (channelName, blockNumber) => {
  try {
		shell.cd(shareFileDir)
    hfc.setConfigSetting('network-map', shareFileDir + '/network-map.yaml');
    let client = hfc.loadFromConfig(hfc.getConfigSetting('network-map'));
    await client.initCredentialStores();
    await client.setUserContext({username: "admin", password: "adminpw"});

		let channel = client.getChannel(channelName);
    
    if(!channel) {
      return Promise.reject('Channel not found')
		}

    let response_payload = await channel.queryBlock(parseInt(blockNumber), `peer0.peer.${orgName.toLowerCase()}.com`);
    
		if (response_payload) {

      let details = {}
      details.blockNumber = blockNumber
      details.blockHash = response_payload.header.data_hash
      details.totalTxns =  response_payload.data.data.length
      details.txns = []

      response_payload.data.data.forEach((txn) => {
        details.txns.push({
          txnid: txn.payload.header.channel_header.tx_id,
          creatorMSPID: txn.payload.header.signature_header.creator.Mspid,
          data: txn.payload.data 
        })
      })

      return Promise.resolve(details)
		} else {
			return Promise.reject('Response payload not found')
		}
	} catch(error) {
		return Promise.reject(error.stack ? error.stack : error)
	}
}

let getLatestBlock = async (channelName) => {
  try {
		shell.cd(shareFileDir)
    hfc.setConfigSetting('network-map', shareFileDir + '/network-map.yaml');
    let client = hfc.loadFromConfig(hfc.getConfigSetting('network-map'));
    await client.initCredentialStores();
    await client.setUserContext({username: "admin", password: "adminpw"});

    let channel = client.getChannel(channelName);
    
    if(!channel) {
      return Promise.reject('Channel not found')
    }
    
    let response_payload = await channel.queryInfo(`peer0.peer.${orgName.toLowerCase()}.com`);
    let latestBlockNumber = response_payload.height - 1
    let blockDetails = await getBlockDetailsByNumber(channelName, latestBlockNumber)

    return Promise.resolve(blockDetails)
  } catch(error) {
    return Promise.reject(error.stack ? error.stack : error)
  }
}

let getTransactionByID = async (channelName, txId) => {
  try {
    shell.cd(shareFileDir)
    hfc.setConfigSetting('network-map', shareFileDir + '/network-map.yaml');
    let client = hfc.loadFromConfig(hfc.getConfigSetting('network-map'));
    await client.initCredentialStores();
    await client.setUserContext({username: "admin", password: "adminpw"});

    let channel = client.getChannel(channelName);
    
    if(!channel) {
      return Promise.reject('Channel not found')
    }

    let response_payload = await channel.queryTransaction(txId, `peer0.peer.${orgName.toLowerCase()}.com`);
		if (response_payload) {
			return Promise.resolve(response_payload)
		} else {
      return Promise.reject('Payload not found')
		}
  } catch(error) {
    return Promise.reject(error.stack ? error.stack : error)
  }
}

let getDirSize = async (myFolder) => {
  return new Promise((resolve, reject) => {
    getSize(myFolder, function(err, size) {
      if (err) {
        resolve(0)
      } else {
        resolve(size)
      }
    });
  })
}

app.get('/explore/getLatestBlock', async (req, res) => {
  let channelName = req.query.channelName
  try {
    let blockDetails = await getLatestBlock(channelName)

    res.send({message: blockDetails})
  } catch(error) {
    res.send({error: true, message: error})
  }
})

app.get('/explore/getBlock', async (req, res) => {
  let channelName = req.query.channelName
  let blockNumber = req.query.blockNumber
  try {
    let blockDetails = await getBlockDetailsByNumber(channelName, blockNumber)
    res.send({message: blockDetails})
  } catch(error) {
    res.send({error: true, message: error})
  }
})

app.get('/explore/getTransaction', async (req, res) => {
  let txnId = req.query.txnId
  let channelName = req.query.channelName

  try {
    let txnDetails = await getTransactionByID(channelName, txnId)
    res.send({message: txnDetails})
  } catch(error) {
    res.send({error: true, message: error})
  }
})

app.get('/explore/size', async (req, res) => {
  try {
    let size = await getDirSize(shareFileDir);
    res.send({
      message: size
    })
  } catch (e) {
    res.send({
      error: true,
      message: 'An error occured'
    })
  }
})

app.get('/explore/getBlocks', async (req, res) => {
  try {
    let channelName = req.query.channelName
    let latestBlock = await getLatestBlock(channelName)
    let end = req.query.end || latestBlock.blockNumber;
    let start = req.query.start;

    if(end > await latestBlock.blockNumber) {
      res.send({
        error: true,
        message: 'End block doesn\'t exist'
      })

      return;
    }

    if(!start) {
      if(end - 30 < 0) {
        start = 0
      } else {
        start = end - 30
      }
    }

    if (end === start || end < start) {
      res.send({
        error: true,
        message: 'End should be greater than start'
      })

      return;
    }

    let blocks = []

    for (let count = start; count <= end; count++) {
      blocks.push(await getBlockDetailsByNumber(channelName, count))
    }

    res.send({
      message: blocks
    })
  } catch (e) {
    res.send({
      error: true,
      message: e
    })
  }
})

app.get('/explore/organisations', async (req, res) => {
  try {
    shell.cd(shareFileDir)
    hfc.setConfigSetting('network-map', shareFileDir + '/network-map.yaml');
    let client = hfc.loadFromConfig(hfc.getConfigSetting('network-map'));
    await client.initCredentialStores();
    await client.setUserContext({username: "admin", password: "adminpw"});

    let channelName = req.query.channelName

    let channel = client.getChannel(channelName);
    let result = await channel.getChannelConfigFromOrderer()

    let orgs = []

    for (let orgName in result.config.channel_group.groups.map.Application.value.groups.map) {
      orgs.push(orgName)
    }

    res.send({
      message: orgs
    })

  } catch(error) {
    res.send({
      message: error,
      error: true
    })
  }
})

app.get('/explore/chaincodesInstantiated', async (req, res) => {
  try {
    shell.cd(shareFileDir)
    hfc.setConfigSetting('network-map', shareFileDir + '/network-map.yaml');
    let client = hfc.loadFromConfig(hfc.getConfigSetting('network-map'));
    await client.initCredentialStores();
    await client.setUserContext({username: "admin", password: "adminpw"});

    let channelName = req.query.channelName

    let channel = client.getChannel(channelName);
    let result = await channel.queryInstantiatedChaincodes(`peer0.peer.${orgName.toLowerCase()}.com`)

    res.send({
      message: result.chaincodes
    })

  } catch(error) {
    res.send({
      message: error,
      error: true
    })
  }
})

//Register Events
setTimeout(() => {
  let result = notifications_db.get('notifications').value()

  result.forEach(async (event) => {
    await registerNotification({ chaincodeName: event.chaincodeName, channelName: event.channelName, chaincodeEventName: event.chaincodeEventName, startBlock: event.startBlock})
  })
}, 10000)

//Discover Peers and Add them to network-map.yaml
let discover = async () => {
  shell.cd(shareFileDir)

  let runCommand = async (channelName) => {
    return new Promise((resolve, reject) => {
      shell.exec(`discover --configFile ${shareFileDir}/discover_conf.yaml peers --channel ${channelName}  --server localhost:7051`, {silent: true}, function(code, stdout, stderr) {
        if(code !== 0 || stderr) {
          reject()
        } else {
          let peers = JSON.parse(stdout);
          let networkMapFile = jsYaml.safeLoad(fs.readFileSync(`${shareFileDir}/network-map.yaml`, 'utf8'));

          if(networkMapFile) {
            if(networkMapFile.peers) {
              networkMapFile.channels[channelName].peers = {} //clear it first
              peers.forEach((peer) => {
                networkMapFile.peers[`peer0.peer.${peer.MSPID.toLowerCase()}.com`] = {
                  "url": `grpc://${peer.Endpoint}`,
                  "chaincodes": peer.Chaincodes || []
                }
                networkMapFile.channels[channelName].peers[`peer0.peer.${peer.MSPID.toLowerCase()}.com`] = {
                  "chaincodeQuery": true,
                  "ledgerQuery": true,
                  "eventSource": true,
                  "discover": true,
                  "endorsingPeer": true
                }
    
                fs.writeFileSync(`${shareFileDir}/network-map.yaml`,  yamlJs.stringify(networkMapFile))
              })
            }  
          }
          resolve()
        }
      });
    })
  }

  let networkMap = jsYaml.safeLoad(fs.readFileSync(`${shareFileDir}/network-map.yaml`, 'utf8'));

  try {
    if(networkMap.channels) {
      for(let channelName in networkMap.channels) {
        await runCommand(channelName)    
      }
    }
  } catch(e) {
    console.log('An exception occured', e)
  }

  setTimeout(discover, 5000)
}

setTimeout(discover, 5000)

app.listen(3000, () => console.log('API Server Running'))
