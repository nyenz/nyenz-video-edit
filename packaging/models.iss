// Made by tools/make_models_iss.py from editforge/modelpack.py. Do not edit by hand.
function ModelCount(): Integer;
begin
  Result := 5;
end;

function ModelUrl(I: Integer): String;
begin
  case I of
    0: Result := 'https://github.com/nyenz/nyenz-video-edit/releases/download/sound-model-1/sound-split-1.onnx';
    1: Result := 'https://github.com/nyenz/nyenz-video-edit/releases/download/caption-model-1/whisper-base-config.json';
    2: Result := 'https://github.com/nyenz/nyenz-video-edit/releases/download/caption-model-1/whisper-base-model.bin';
    3: Result := 'https://github.com/nyenz/nyenz-video-edit/releases/download/caption-model-1/whisper-base-tokenizer.json';
    4: Result := 'https://github.com/nyenz/nyenz-video-edit/releases/download/caption-model-1/whisper-base-vocabulary.txt';
  else
    Result := '';
  end;
end;

function ModelTempName(I: Integer): String;
begin
  case I of
    0: Result := 'model0-sound-split-1.onnx';
    1: Result := 'model1-config.json';
    2: Result := 'model2-model.bin';
    3: Result := 'model3-tokenizer.json';
    4: Result := 'model4-vocabulary.txt';
  else
    Result := '';
  end;
end;

function ModelDest(I: Integer): String;
begin
  case I of
    0: Result := 'models\sound-split-1.onnx';
    1: Result := 'models\whisper-base\config.json';
    2: Result := 'models\whisper-base\model.bin';
    3: Result := 'models\whisper-base\tokenizer.json';
    4: Result := 'models\whisper-base\vocabulary.txt';
  else
    Result := '';
  end;
end;

function ModelSha(I: Integer): String;
begin
  case I of
    0: Result := 'b43c4978c07667b2c6e6aed8c3c1ad5b263a96f8fbc8faead2cec45971646d4d';
    1: Result := '56a6d8110d311f19c8f0471e562832c7527f146b567275bfca59fcf7c184da9a';
    2: Result := 'd01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9';
    3: Result := 'fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab';
    4: Result := '34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913';
  else
    Result := '';
  end;
end;

function ModelSize(I: Integer): Int64;
begin
  case I of
    0: Result := 76080146;
    1: Result := 2309;
    2: Result := 145217532;
    3: Result := 2203239;
    4: Result := 459861;
  else
    Result := 0;
  end;
end;
