import express from "express";
import mongoose from "mongoose";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import cors from "cors";
import crypto from "crypto";
import multer from "multer";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import {
    S3Client,
    PutObjectCommand,
    DeleteObjectCommand,
} from "@aws-sdk/client-s3";
dotenv.config();

const saltRounds = 10;

const randomImageName = (bytes = 32) => crypto.randomBytes(bytes).toString("hex");
function toTitleCase(str) {
    return str
      .toLowerCase()
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
}

const bucketRegion = process.env.BUCKET_REGION;
const bucketName = process.env.BUCKET_NAME;
const accessKey = process.env.ACCESS_KEY;
const secretAccessKey = process.env.SECRET_ACCESS_KEY;

const s3 = new S3Client({
    credentials: {
      accessKeyId: accessKey,
      secretAccessKey: secretAccessKey,
    },
    region: bucketRegion,
});

const connectDB = async () => {
    try {
      const conn = await mongoose.connect(process.env.MONGO_URI);
      console.log(`MongoDB Connected: ${conn.connection.host}`);
    } catch (error) {
      console.log(error);
      process.exit(1);
    }
}

const app = express();

app.use(express.json());
app.use(
  bodyParser.urlencoded({
    extended: true,
  })
);

const storage = multer.memoryStorage({
    limits: {
      fieldSize: 50 * 1024 * 1024,
    },
});
const upload = multer({ storage: storage });

const corsOptions = {
    origin: ["http://localhost:3000"],
    credentials: true,
};
  
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

const barberSchema = {
    fName: String ,
    lName: String,
    email: String,
    password: String,
    imageURL: String,
    role: String
}

const serviceSchema = {
    barberID: String,
    title: String,
    length: String,
    description: String,
    price: Number,
}

const Barber = new mongoose.model("Barber", barberSchema);
const Service = new mongoose.model("Services", serviceSchema);

app.get("/barbers", async (req, res) => {
    try{
        const foundBarbers = await Barber.find({}).exec();
        if (!foundBarbers) {
            res.send(500).json({message: "No barbers found."});
        }
        res.status(200).json(foundBarbers);
    } catch (error) {
        console.log('Error in getting all the barbers', error);
        res.status(500).json({message: "Could not get barbers."});
    }
})

app.post("/login", async(req, res) => {
    try {
        const { email, password } = req.body;

        const foundBarber = await Barber.findOne({email: email.toLowerCase()}).exec();
        if (!foundBarber) {
            return res.status(404).json({message: "User not found."})
        } else {
            const result = await bcrypt.compare(password, foundBarber.password);

            if (result) {
                const accessToken = jwt.sign(foundBarber._id.toJSON(), process.env.ACCESS_TOKEN_SECRET);
        
                res.cookie("access_token", accessToken, {
                  httpOnly: true,
                  secure: true,
                  maxAge: 15 * 60 * 1000,
                });
        
                res.status(200).json({
                  message: "Login successful",
                  role: foundBarber.role,
                  accessToken: accessToken,
                  _id: foundBarber._id,
                  fName: foundBarber.fName,
                  lName: foundBarber.lName,
                  email: foundBarber.email
                });
            } else {
                res.status(403).json({message: "Invalid credentials."})
            }
        }
    }
    catch (error) {
        console.log(error);
        res.status(500).json({message: "Error logging in."})
    }

})

app.post("/barbers", upload.single("image"), async (req, res) => {
    try{
        const fName = toTitleCase(req.body.fName);
        const lName = toTitleCase(req.body.lName);
        const foundBarber = await Barber.findOne({ fName: fName, lName: lName }).exec();

        if (foundBarber) {
            return;
        }

        const hash = await bcrypt.hash(req.body.password, saltRounds);

        const imageName = randomImageName();

        const params = {
            Bucket: bucketName,
            Key: imageName,
            Body: req.file.buffer,
            ContentType: req.file.mimetype,
        };

        const putCommand = new PutObjectCommand(params);

        await s3.send(putCommand);

        const url = `https://${bucketName}.s3.${bucketRegion}.amazonaws.com/${imageName}`;

        const barber = new Barber ({
            fName: fName,
            lName: lName,
            email: req.body.email.toLowerCase(),
            password: hash,
            imageURL: url,
            role: "Barber"
        })

        await barber.save();

        const accessToken = jwt.sign(barber._id.toJSON(), process.env.ACCESS_TOKEN_SECRET);

        res.cookie("access_token", accessToken, {
            httpOnly: true,
            secure: true,
            maxAge: 15 * 60 * 1000,
        });
    
        res.status(201).json({
            message: "Barber added successfully",
            role: barber.role,
            accessToken: accessToken,
            _id: barber._id,
            fName: barber.fName,
            lName: barber.lName,
            email: barber.email
        });

    } catch (error) {
        console.log(error);
        res.status(500).json({message: "Unable to add barber."})
    }
})

app.get("/service", async (req, res) => {
    try{
        const services = await Service.find({barberID: req.query._id});
        if (services) {
            res.status(201).json(services)
        } else {
            res.status(500).json({message: "No services found."})
        }
    }
    catch (err) {
        console.log(err);
        res.status(500).json({message: "Error getting services."})
    }

})

app.post("/service", async(req, res) => {
    try {
        const foundService = await Service.findOne({title: req.body.title}).exec();
        if (foundService) {
            return res.status(409).json({message: "A service with the same title already exists."});
        }

        const service = new Service ({
            title: req.body.title,
            description: req.body.description,
            price: parseFloat(req.body.price),
            length: req.body.length,
            barberID: req.body.barberID
        })
        await service.save();
        res.status(201).json({message: "Service created successfully.", _id: service._id, title: service.title});
    }
    catch (err) {
        console.log(err);
        res.status(500).json({message: "An error occured while trying to find a service with the same title as that"});
    }
})


connectDB().then(() => {
    app.listen(9000, () => {
        console.log("Listening on port 9000!");
    })
})