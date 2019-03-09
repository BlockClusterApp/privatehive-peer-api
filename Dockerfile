FROM hyperledger/fabric-tools:1.4
RUN apt-get update && apt-get install -y --no-install-recommends apt-utils build-essential
RUN apt-get install jq

RUN curl -sSL http://bit.ly/2ysbOFE | bash -s 1.3.0
RUN mv  ./fabric-samples/bin/* /usr/local/bin
RUN curl -sL https://deb.nodesource.com/setup_8.x | bash
RUN apt-get install -y nodejs
