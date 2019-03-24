const MongoClient = require("mongodb").MongoClient;
const instanceId = (process.env.ORG_NAME).toLowerCase();
const Config = require('./config');

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
      db.collection("privatehivePeers").findOne(
        { instanceId: instanceId },
        function(err, node) {
          if (!err && node) {
            if (node.status === undefined) {
              db.collection("privatehivePeers").updateOne(
                { instanceId: instanceId },
                { $set: { status: "initializing" } },
                function(err, res) {
                  process.exit(0);
                }
              );
            } else if (node.status === "down") {
              db.collection("privatehivePeers").updateOne(
                { instanceId: instanceId },
                { $set: { status: "running" } },
                function(err, res) {
                  process.exit(0);
                }
              );
            } else {
              process.exit(0);
            }
          } else {
            process.exit(0);
          }
        }
      );
    } else {
      process.exit(0);
    }
  }
);
