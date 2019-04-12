const MongoClient = require("mongodb").MongoClient;
const instanceId = process.env.INSTANCE_ID;
const Config = require("./config");

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
        { instanceId: instanceId },
        { $set: { status: "down" } },
        function(err, res) {
          process.exit(0);
        }
      );
    } else {
      process.exit(0);
    }
  }
);
