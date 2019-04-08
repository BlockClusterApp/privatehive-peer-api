FROM hyperledger/fabric-tools:1.4
RUN apt-get update && apt-get install -y --no-install-recommends apt-utils build-essential
RUN apt-get install jq

RUN curl -sSL http://bit.ly/2ysbOFE | bash -s 1.3.0
RUN mv  ./fabric-samples/bin/* /usr/local/bin
RUN curl -sL https://deb.nodesource.com/setup_8.x | bash
RUN apt-get install -y nodejs screen

RUN sudo apt-get install -y apt-transport-https ca-certificates curl gnupg-agent software-properties-common
RUN curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo apt-key add -
RUN apt-key fingerprint 0EBFCD88
RUN sudo add-apt-repository "deb [arch=amd64] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable"
RUN apt-get update
RUN apt-get install -y docker-ce docker-ce-cli containerd.io
RUN ln -s  /host/var/run/docker.sock /var/run/docker.sock

COPY ./src ./src
WORKDIR ./src
RUN npm install

CMD ["node", "app.js"]