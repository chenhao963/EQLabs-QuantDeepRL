const amqp = require('amqplib/callback_api')
const winston = require('winston')
const ccxt = require('ccxt')
const { cancelOrderSchema, createOrderSchema } = require('./schema')
const validateCancelOrder = ajv.compile(cancelOrderSchema)
const validateCreateOrder = ajv.compile(createOrderSchema)

class Exchange {
  constructor (exchange, rabbitMqHostAddr, market, logLevel) {
    this.logger = winston.createLogger({
      level: logLevel || 'info',
      defaultMeta: { service: 'executor-' + exchange },
      transports: [
        new winston.transports.Console({
          format: winston.format.json()
        })
      ]
    })

    this.queue = exchange
    this.rabbitMqHostAddr = rabbitMqHostAddr
    this.market = market

    if (!process.env.API_KEY || !process.env.API_SECRET) {
      throw new Error("No API secrets defined!")
    }

    this.exchange = new ccxt[exchange]({
        apiKey: process.env.API_KEY,
        secret: process.env.API_SECRET,
        timeout: 30000,
        enableRateLimit: true,
    })

    this.rabbitmq = undefined


    this.logger.info('Executor started on queue: ', this.queue, this.rabbitMqHostAddr)
  }

  wait (duration) {
    return new Promise(resolve => {
      setTimeout(resolve, duration)
    })
  }

  async connectToRabbitMq () {
    return new Promise((resolve, reject) => {
      amqp.connect(this.rabbitMqHostAddr, (error0, connection) => {
        if (error0) {
          this.logger.error('Connection to RabbitMQ failed: ' + error0)
          reject(error0)
        }
        this.logger.info('Successfully connected to rabbitmq')
        connection.createChannel((error1, channel) => {
          if (error1) {
            this.logger.error('Creating a channel on RabbitMQ failed: ' + error1)
            reject(error1)
          }

          channel.assertQueue(this.queue, {
            autoDelete: false,
            durable: false,
            arguments: {
              'x-message-ttl': 20000
            }
          })

          this.logger.info('Successfully created a message queue: ' + this.queue)
          this.rabbitmq = channel

          resolve(true)
        })
      })
    })
  }

  async parseMessage(msg) {
    const json = JSON.parse(msg.toString())
    let validate
    if (json.operation === "cancel") {
      validate = validateCancelOrder
    } else if (json.operation === "create") {
      validate = validateCreateOrder
    }
    if (!validate(json)) {
      this.logger.error(validate.errors);
      return false
    }

    try {
      switch json.operation {
        case "cancel":
          const result = await this.exchange.cancelOrder(json.id)
          this.logger.info("Order successfully canceled: " + result)
          // TODO: Remove canceled order from open orders in redis
          break;
        case "create":
          const result = await this.exchange.createOrder(symbol: json.symbol, type: json.orderType, side: json.side, amount: json.amount, price: json.price)
          this.logger.info("Order successfully created: " + result)
          // TODO: Save created order to open orders in redis
          break;
      }
    } catch(error) {
      this.logger.error("Error executing operation " + error)
    }

    console.log(json)
  }

  run () {
    this.rabbitmq.consume(this.queue, (msg) => {
      this.parseMessage(msg.content)
    }, {
      noAck: true
    })
  }
}

module.exports = Exchange
