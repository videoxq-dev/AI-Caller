"use client";

import { useState } from "react";
import { EyeIcon, EyeOffIcon } from "./icons";

type PasswordFieldProps = {
  id?: string;
  label?: string;
  autoComplete?: string;
  placeholder?: string;
};

export function PasswordField({ id = "password", label = "Password", autoComplete = "current-password", placeholder = "Enter your password" }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);

  return (
    <label className="field" htmlFor={id}>
      {label ? <span className="fieldLabel">{label}</span> : null}
      <span className="passwordWrap">
        <input id={id} name={id} type={visible ? "text" : "password"} autoComplete={autoComplete} placeholder={placeholder} required minLength={8} />
        <button className="iconButton" type="button" onClick={() => setVisible((v) => !v)} aria-label={visible ? "Hide password" : "Show password"}>
          {visible ? <EyeOffIcon size={20} /> : <EyeIcon size={20} />}
        </button>
      </span>
    </label>
  );
}
