const WebSocket = require('ws');
const mqtt = require('mqtt');
const fs = require('fs');

class StoveComm {
	constructor(valid_auths, writable_nodes) {
		this.mqtt = null;
		this.stove_sockets = {};
		this.valid_auths = valid_auths;
		this.writeable = new Set(writable_nodes);
		this.topic = "fumis/";
		this.stove_sockets = {};
		console.debug("Will accecpt stoves: ", valid_auths);
		console.debug("Writable nodes in stoves are: ", writable_nodes);
	}

	mqttConnected(mqtt){
		console.log("MQTT connected")
		this.mqtt = mqtt;
		mqtt.on("message", (topic, payload)=>{this.onMqttMessage(topic, payload)});
	}

	onMqttMessage(topic, payload){
		let subpath;
		let parts;
		let unitid;
		if (topic.indexOf(':set') < 0) {
			return;
		}
		// TODO remove :set suffix more appropriately
		topic = topic.replace(":set", "");

		try{
			subpath = topic.replace(this.topic, "");
			console.log("Subpath "+subpath);
			parts = subpath.split("/");
			console.log("Parts "+parts);
			unitid = parts[0];
			parts = parts.slice(1);
		} catch (error) {
			console.error("Could not parse topic '"+topic+"'");
			return;
		}

		// Check if writable
		const dest_path = parts.join("/");
		if (! this.writeable.has(dest_path)) {
			console.warning("Destination "+dest_path+" is not writable");
			return;
		}

		// Prepare payload
		const command = JSON.parse(payload);

		const build_object = function(props) {
			const nextprops = props.slice(0, props.length-1);
			const prop = props[props.length-1];
			let obj = {}
			if (nextprops.length > 0)
				obj[prop] = build_object(nextprops);
			else
				obj[prop] = command;
			return obj;
		}

		if (! (unitid in this.stove_sockets)) {
			console.error("Message to unknown stove "+unitid);
			return;
		}

		let command_struct = this.prepareStoveCommand(unitid);
		Object.assign(command_struct, build_object(parts.reverse()));
		console.log(command_struct);

		this.stove_sockets[unitid].send(JSON.stringify(command_struct));
	}

	prepareStoveCommand(unitid){
		return { "apiVersion":"1.3",
			"controller":{},
			"unit": {
				"id": unitid,
				"pin": this.valid_auths[unitid],
				"version": "2.3.0" // MAGIC?!, Seems to come from stove from time to time...
			}
		}
	}

	stoveConnected(stove_socket){
		console.log("Stove connected")
		// Don't do anything unless the stove sent a valid packet
		// for now
	}

	stoveDisconnected(socket){
		let id = null;
		for (id in this.stove_sockets){
			const s = this.stove_sockets[id];
			if (socket === s){
				delete this.stove_sockets[id];
				return;
			}
		}
	}

	dataFromStove(packet, socket){
		if (this.stove_socket === null){
			return;
		}
		if (packet.unit.pin === undefined ) {
			return;
		}
		const unitid = packet.unit.id;

		console.debug("Data from stove " + unitid);
		if ( this.valid_auths[unitid] != packet.unit.pin ) {
			return;
		}
		this.publish_recursively(packet, this.topic+unitid);

		if (! (unitid in this.stove_sockets)) {
			this.newStove(unitid, socket);
			console.log("Stove " + unitid + " connected");
		}
	}

	newStove(unitid, socket){
		this.stove_sockets[unitid] = socket;
		const topic = this.topic + unitid + "/#"
		this.mqtt.subscribe([topic], () => {
			console.log(`Subscribe to topic '${topic}'`)
		})
	}

	publish_recursively(data, path) {
		if (this.mqtt == null) return;
		for ( const property in data ){
			const topic = path+"/"+property;
			const value = data[property];
			if (!data.hasOwnProperty(property)) continue;
			if (typeof(data[property])==='object') {
				this.publish_recursively(data[property], topic);
			} else {
				// console.debug("Publish "+topic+" "+value);
				this.mqtt.publish(topic, JSON.stringify(value), { qos: 0, retain: false }, (error) => {
					if (error) {
						console.error(error)
					}
				})
			}
		}
	}
}

const config_filename = process.argv[2] ? process.argv[2] : "config.json";
const config_file = fs.readFileSync(config_filename);
const config = JSON.parse(config_file);

const comm = new StoveComm(config.websocket.known_stoves, config.writable);

const server = new WebSocket.Server({
	port: 8080
});

server.on('connection', function(socket) {
	comm.stoveConnected(socket);

	socket.on('message', function(msg) {
		comm.dataFromStove(JSON.parse(msg), socket);
	});

	socket.on('close', function() {
		comm.stoveDisconnected(socket);
	});
});

const clientId = `mqtt_${Math.random().toString(16).slice(3)}`;

const connectUrl = `mqtt://${config.mqtt.host}:${config.mqtt.port}`;

console.debug("Connecting to "+connectUrl);

const mqtt_client = mqtt.connect(connectUrl, {
	clientId,
	clean: true,
	connectTimeout: 4000,
	username: config.mqtt.username,
	password: config.mqtt.password,
	reconnectPeriod: 1000,
});

mqtt_client.on('connect', () => {
	comm.mqttConnected(mqtt_client);
})
