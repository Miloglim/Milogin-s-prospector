import React from "react";
import { createRoot } from "react-dom/client";
import { AdminApp } from "./ui";
import { readChallenge } from "./api";
import "antd/dist/reset.css";
import "./style.css";

const challenge = readChallenge();
createRoot(document.getElementById("root")!).render(<React.StrictMode><AdminApp initialChallenge={challenge}/></React.StrictMode>);
