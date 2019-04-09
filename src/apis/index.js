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

const shareFileDir = process.env.SHARE_FILE_DIR || './crypto' 
const orgName = toPascalCase(process.env.ORG_NAME)

app.use(bodyParser.json())
app.use(multer({dest:`${shareFileDir}/uploads/`}).single('chaincode_zip'));

shell.mkdir('-p', `${shareFileDir}/uploads/`)

async function executeCommand(cmd) {
  if (shell.exec(cmd, {shell: '/bin/bash'}).code !== 0) {
    console.log("Failed", cmd)
    return Promise.reject();
  } else {
    return Promise.resolve();
  }
}

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

    shell.mkdir('-p', `${shareFileDir}/chaincodes/${chaincodeName}/1.0/${chaincodeLanguage}/`)
    unzipper.extract({ path:  `${shareFileDir}/chaincodes/${chaincodeName}/1.0/${chaincodeLanguage}/`});

    setTimeout(() => {

      /*
        For nodejs: create a directory with name of the chaincode and place code files in it. While uploading zip the folder
        For go lang: zip the src directory in $GOPATH and upload it
      */

      let folderName = chaincodeName //chaincodeLanguage === 'node' ? chaincodeName : 'src'
      shell.exec(`mv ${shareFileDir}/chaincodes/${chaincodeName}/1.0/${chaincodeLanguage}/${folderName}/* ${shareFileDir}/chaincodes/${chaincodeName}/1.0/${chaincodeLanguage}/`)
      shell.exec(`rm -rf ${shareFileDir}/chaincodes/${chaincodeName}/1.0/${chaincodeLanguage}/${folderName}`)  
      res.send({message: 'Chaincode added successfully'})
    }, 3000)
  } else {
    res.send({error: true, message: 'Chaincode missing'})
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

  if(langauge === 'golang') {
    await executeCommand(`peer chaincode install -n ${chaincodeName} -p ${chaincodePath} -v ${version} -l golang`)
    res.send({message: 'Chaincode installed successfully'})
  } else {
    let request = {
      targets: [`peer0.peer.${orgName.toLowerCase()}.com`],
      chaincodePath,
      chaincodeId: chaincodeName,
      chaincodeVersion: version,
      chaincodeType: langauge
    };
  
    let results = await client.installChaincode(request);
    let proposalResponses = results[0];
    let proposal = results[1];
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

  shell.cd(shareFileDir)

  hfc.setConfigSetting('network-map', shareFileDir + "/network-map.yaml");
  let client = hfc.loadFromConfig(hfc.getConfigSetting('network-map'));
  
  var error_message = null;

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

    if(fcn)
      request.fcn = fcn;
        
    if(args)
      request.args = args

    let results = await channel.sendInstantiateProposal(request, 60000);

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

app.post('/chaincodes/invoke', async (req, res) => {
  let error_message = null;
  let tx_id_string = null;
  
  shell.cd(shareFileDir)

  let channelName = req.body.channelName
  let chaincodeName = req.body.chaincodeName
  let fcn = req.body.fcn
  let args = req.body.args

  try {
  
    hfc.setConfigSetting('network-map', shareFileDir + '/network-map.yaml');
    let client = hfc.loadFromConfig(hfc.getConfigSetting('network-map'));
    await client.initCredentialStores();
    await client.setUserContext({username: "admin", password: "adminpw"});
  
    let channel = client.getChannel(channelName);
  
    var tx_id = client.newTransactionID();
    tx_id_string = tx_id.getTransactionID();
  
    var request = {
      targets: [`peer0.peer.${orgName.toLowerCase()}.com`],
      chaincodeId: chaincodeName,
      fcn: fcn,
      args: args,
      chainId: channelName,
      txId: tx_id
    };
  
    let results = await channel.sendTransactionProposal(request);
  
    var proposalResponses = results[0];
    var proposal = results[1];
    var all_good = true;

    var all_good = true;
		for (var i in proposalResponses) {
			let one_good = false;
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
  } catch(error) {
    error_message = error.toString();
  }

  if (!error_message) {
		let message = `Successfully invoked the chaincode ${chaincodeName} to the channel ${channelName} for transaction ID: ${tx_id_string}`;
    res.send({message})
	} else {
		let message = `Failed to invoke chaincode. cause: ${error_message}`
    res.send({error: true, message})
	}
})

app.post('/notifications/add', async (req, res) => {
  
  shell.cd(shareFileDir)

  let chaincodeName = req.body.chaincodeName
  let channelName = req.body.channelName
  let chaincodeEventName = req.body.chaincodeEventName

  hfc.setConfigSetting('network-map', shareFileDir + '/network-map.yaml');
  let client = hfc.loadFromConfig(hfc.getConfigSetting('network-map'));
  await client.initCredentialStores();

  let channel = client.getChannel(channelName);
  let eventHub = channel.getChannelEventHubsForOrg(orgName)[0];
  eventHub.connect(true);
  eventHub.registerChaincodeEvent(chaincodeName, chaincodeEventName,
    (event, block_num, txnid, status) => {
      console.log('Successfully got a chaincode event with transid:'+ txnid + ' with status:'+ status);
      console.log('Successfully received the chaincode event on block number '+ block_num);
      console.log(atob(event.payload.toString('base64')));
    },
    (error)=>{
      console.log('Failed to receive the chaincode event ::'+error);
    }
  );

  res.send({message: 'Registered'})
})

app.listen(3000, () => console.log('API Server Running'))