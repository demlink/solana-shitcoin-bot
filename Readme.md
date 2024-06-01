## FLOW

#install
	- setup the Node.js
	Go to the Node.js Downloads page(https://nodejs.org/en/download)
	Download Node.js for macOS by clicking the "Macintosh Installer" option
	Run the downloaded Node.js .pkg Installer
	Run the installer, including accepting the license, selecting the destination, and authenticating for the install.
	You're finished! To ensure Node.js has been installed, run node -v in your terminal 
	
	- install packages
	run the 'npm install' on terminal


1. Create Token

	ts-node index.ts create_token

2. Update Metadata

	ts-node index.ts update_metadata -a <tokenaddress>

3. Create Market
    
	ts-node index.ts create-openbook -a <tokenaddress> -m <minimum order size> -t <minimum price tick>

4. Create Pool and Snipe

    ts-node index.ts pool-snipe -o <openbook> -ta <tokenamount> -sa <solamount> -t <time>

5. Airdrop

	ts-node index.ts airdrop -m <tokenaddress>

6. Remove LP

	ts-node index.ts remove -p <pooladdress> -a <amount>  //set amount -1 to remove all liquidity

Donate: 5aGbT8aJmj5k1m45DeWygsvbax5xrhpLYeSZoMkMvAig
Enquiry_telegram: @lionelemmark

