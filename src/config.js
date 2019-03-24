module.exports = {
  mongoUrl: process.env.MONGO_URL || "mongo.default.svc.cluster.local:27017",
  getMongoConnectionString() {
      return process.env.MONGO_URL || "mongodb://mongo.default.svc.cluster.local:27017"
  },
  getDatabase() {
      const a  = process.env.MONGO_URL;
      if(!a){
          return "admin";
      }

      if(a.indexOf("?replica") === -1 ){
          return "admin"
      }
      const db = a.substring(a.lastIndexOf("/")+1, a.lastIndexOf("?replica"));
      if(!db){
          return "admin";
      }
      return db;
  }
}